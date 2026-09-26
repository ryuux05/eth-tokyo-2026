import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { network } from "hardhat";
import { concatHex, encodeFunctionData, keccak256, parseAbiItem, parseEther, parseEventLogs, toBytes, toHex, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAgentSdk, Decision, encodeAgentExecution, encodePolicy } from "../sdk/agent.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const userOperationEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)");

const { viem, networkName } = await network.create();
if (networkName !== "localhost") throw new Error("This demo must run with --network localhost");
const client = await viem.getPublicClient();
const [owner] = await viem.getWalletClients();
const chainId = await client.getChainId();
const operatingKey = generatePrivateKey(); // Ephemeral stand-in for a KMS-held key.
const authenticator = privateKeyToAccount(operatingKey);

const entryPoint = await viem.deployContract("RealEntryPoint");
const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
const salt = generatePrivateKey(); // A fresh bytes32 salt avoids collisions on a persistent local node.
const agent = await factory.read.predictAgent([owner.account.address, salt]) as Address;
const created = await factory.write.createAgent([authenticator.address, salt]);
await client.waitForTransactionReceipt({ hash: created });
const account = await viem.getContractAt("AgentAccount4337", agent);
const target = await viem.deployContract("PolicyActionTarget");
const data = encodeFunctionData({ abi: target.abi, functionName: "purchase", args: [keccak256(toBytes("local-rpc-demo"))] });
const policy = encodePolicy([{ target: target.address, selector: data.slice(0, 10) as Hex,
  token: zeroAddress, maxValue: 0n, maxAmount: 0n, decision: Decision.ALLOW }]);
const configured = await owner.writeContract({ address: agent, abi: account.abi, functionName: "setPolicy", args: [policy] });
await client.waitForTransactionReceipt({ hash: configured });
const deposited = await entryPoint.write.depositTo([agent], { value: parseEther("0.01") });
await client.waitForTransactionReceipt({ hash: deposited });

const agentSdk = createAgentSdk({ agentId: agent, chainId, signDigest: digest => authenticator.sign({ hash: digest }) });
const unsigned = {
  sender: agent,
  nonce: await entryPoint.read.getNonce([agent, 0n]),
  initCode: "0x" as Hex,
  callData: encodeAgentExecution(target.address, 0n, data),
  accountGasLimits: concatHex([toHex(1_000_000n, { size: 16 }), toHex(500_000n, { size: 16 })]),
  preVerificationGas: 100_000n,
  gasFees: concatHex([toHex(1_000_000_000n, { size: 16 }), toHex(2_000_000_000n, { size: 16 })]),
  paymasterAndData: "0x" as Hex,
  signature: "0x" as Hex,
};
const userOpHash = await entryPoint.read.getUserOpHash([unsigned]) as Hex;
const signature = await agentSdk.signUserOperationHash(userOpHash);
const sent = await entryPoint.write.handleOps([[{ ...unsigned, signature }], owner.account.address]);
const receipt = await client.waitForTransactionReceipt({ hash: sent });
const events = parseEventLogs({ abi: [userOperationEvent], logs: receipt.logs, eventName: "UserOperationEvent" });
assert.equal(events.length, 1);
assert.equal(events[0].args.userOpHash, userOpHash);
assert.equal(events[0].args.success, true);
assert.equal(await target.read.calls(), 1n);
assert.equal(await entryPoint.read.getNonce([agent, 0n]), 1n);

const serviceScript = fileURLToPath(new URL("./demo/service.ts", import.meta.url));
const agentScript = fileURLToPath(new URL("./demo/agent.ts", import.meta.url));
const mcpScript = fileURLToPath(new URL("../mcp/server.ts", import.meta.url));
const children: ChildProcess[] = [];

function childScript(path: string, envKey: string, config: object): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", path], {
    env: { ...process.env, [envKey]: JSON.stringify(config) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr?.on("data", chunk => process.stderr.write(chunk));
  children.push(child);
  return child;
}

async function startService(kind: "owner" | "manual"): Promise<{ url: string; audience: string }> {
  const audience = kind === "owner" ? "https://service-a.example" : "https://service-b.example";
  const child = childScript(serviceScript, "DEMO_SERVICE_CONFIG", {
    kind, chainId, audience, implementation: await factory.read.implementation(),
    agentId: agent, owner: owner.account.address,
  });
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${kind} service startup timed out`)), 15_000);
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", line => {
      if (!line.startsWith("DEMO_READY ")) return;
      clearTimeout(timer);
      try { resolve((JSON.parse(line.slice("DEMO_READY ".length)) as { port: number }).port); }
      catch (error) { reject(error); }
    });
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`${kind} service exited before ready: ${code}`)); });
  });
  return { url: `http://127.0.0.1:${port}`, audience };
}

async function runAgent(phase: "active" | "revoked",
  serviceA: { url: string; audience: string }, serviceB: { url: string; audience: string }) {
  const child = childScript(agentScript, "DEMO_AGENT_CONFIG", {
    agentId: agent, chainId, operatingKey, phase,
    serviceA, serviceB,
  });
  await new Promise<void>((resolve, reject) => {
    child.stdout?.on("data", chunk => process.stdout.write(chunk));
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`Agent demo exited: ${code}`)));
  });
}

async function runMcp(serviceA: { url: string; audience: string }, serviceB: { url: string; audience: string },
  phase: "active" | "revoked") {
  const temporary = await mkdtemp(join(tmpdir(), "agentic-world-mcp-"));
  try {
    const configPath = join(temporary, "config.json");
    await writeFile(configPath, JSON.stringify({
      rpcUrl: "http://127.0.0.1:8545", chainId, agentId: agent, implementation: await factory.read.implementation(),
      services: {
        owner: { baseUrl: serviceA.url, audience: serviceA.audience, methods: ["GET"], paths: ["/private/report"] },
        manual: { baseUrl: serviceB.url, audience: serviceB.audience, methods: ["GET"], paths: ["/private/compute", "/private/admin"] },
      },
    }));
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", mcpScript],
      env: { ...process.env, AGENTIC_WORLD_CONFIG: configPath, AGENTIC_WORLD_OPERATING_KEY: operatingKey } as Record<string, string> });
    const mcp = new Client({ name: "agentic-world-local-test", version: "0.1.0" });
    await mcp.connect(transport);
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await mcp.callTool({ name, arguments: args });
      const block = response.content?.[0];
      assert(block?.type === "text");
      return { error: response.isError === true, data: JSON.parse(block.text) as Record<string, unknown> };
    };
    try {
      const tools = await mcp.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["agentic_identity", "agentic_policy_check", "agentic_request"]);
      const identity = await call("agentic_identity", {});
      assert.equal(identity.error, false);
      assert.equal(String(identity.data.agentId).toLowerCase(), agent.toLowerCase());
      assert.equal(identity.data.authenticationRevoked, phase === "revoked");
      const preview = await call("agentic_policy_check", { target: target.address, valueWei: "0", data });
      assert.equal(preview.data.decision, "ALLOW");
      const first = await call("agentic_request", { url: `${serviceA.audience}/private/report`, method: "GET" });
      if (phase === "revoked") {
        assert.equal(first.error, true);
        assert.equal(first.data.code, "AUTHENTICATOR_REVOKED");
      } else {
        assert.equal(first.data.status, 200);
        assert.equal(first.data.sessionEstablished, true);
        const repeated = await call("agentic_request", { url: `${serviceA.audience}/private/report`, method: "GET" });
        assert.equal(repeated.data.status, 200);
        assert.equal(repeated.data.usedSession, true);
        const second = await call("agentic_request", { url: `${serviceB.audience}/private/compute`, method: "GET" });
        assert.equal(second.data.status, 200);
        const forbidden = await call("agentic_request", { url: `${serviceB.audience}/private/admin`, method: "GET" });
        assert.equal(forbidden.data.status, 403);
        const blocked = await call("agentic_request", { url: `${serviceA.audience}/private/admin`, method: "GET" });
        assert.equal(blocked.error, true);
        assert.equal(blocked.data.code, "REQUEST_NOT_ALLOWED");
      }
      console.log(`MCP_RESULT ${JSON.stringify({ phase, agentId: agent, tools: tools.tools.length, status: first.data.status ?? first.data.code })}`);
    } finally { await mcp.close(); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}

try {
  const serviceA = await startService("owner");
  const serviceB = await startService("manual");
  await runAgent("active", serviceA, serviceB);
  await runMcp(serviceA, serviceB, "active");
  const revoked = await owner.writeContract({ address: agent, abi: account.abi, functionName: "revokeAuthenticator" });
  await client.waitForTransactionReceipt({ hash: revoked });
  await runAgent("revoked", serviceA, serviceB);
  await runMcp(serviceA, serviceB, "revoked");
  console.log(JSON.stringify({ chainId, owner: owner.account.address, entryPoint: entryPoint.address,
    factory: factory.address, implementation: await factory.read.implementation(), agent,
    authenticator: authenticator.address, policyTarget: target.address, userOpHash, transaction: sent,
    revokeTransaction: revoked, serviceA: serviceA.url, serviceB: serviceB.url }, null, 2));
} finally {
  await Promise.all(children.map(stopChild));
}
