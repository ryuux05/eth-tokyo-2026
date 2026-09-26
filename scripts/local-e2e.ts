import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { network } from "hardhat";
import { concatHex, decodeFunctionData, encodeFunctionData, keccak256, parseAbiItem, parseEther, parseEventLogs, toBytes, toHex, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAgentSdk, Decision, encodeAgentExecution, encodePolicy } from "../sdk/agent.js";
import { agentAccountAbi, agentAccountFactoryAbi, agentPolicyAbi } from "../sdk/core.js";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

const userOperationEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)");

const { viem, networkName } = await network.create();
if (networkName !== "localhost") throw new Error("This demo must run with --network localhost");
const rpcUrl = process.env.DEMO_RPC_URL ?? "http://127.0.0.1:8545";
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
const signerFixtureScript = fileURLToPath(new URL("./demo/LocalSignerFixture.mjs", import.meta.url));
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
    kind, chainId, audience, rpcUrl, implementation: await factory.read.implementation(),
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
      rpcUrl, chainId, agentId: agent, factory: factory.address,
      implementation: await factory.read.implementation(),
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
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ["agentic_create_identity",
        "agentic_identity", "agentic_policy_check", "agentic_rotate_authenticator", "agentic_session_proof", "agentic_set_policy"]);
      const identity = await call("agentic_identity", {});
      assert.equal(identity.error, false);
      assert.equal(String(identity.data.agentId).toLowerCase(), agent.toLowerCase());
      assert.equal(identity.data.authenticationRevoked, phase === "revoked");
      const preview = await call("agentic_policy_check", { target: target.address, valueWei: "0", data });
      assert.equal(preview.data.decision, "ALLOW");
      if (phase === "active") {
        const prepared = await call("agentic_create_identity", { owner: owner.account.address, salt: generatePrivateKey() });
        assert.equal(prepared.error, false);
        assert.equal(prepared.data.status, "OWNER_TRANSACTION_REQUIRED");
        assert.equal((prepared.data.transaction as { to: Address }).to.toLowerCase(), factory.address.toLowerCase());
        assert.equal(decodeFunctionData({ abi: agentAccountFactoryAbi,
          data: (prepared.data.transaction as { data: Hex }).data }).functionName, "createAgent");
        const policyIntent = await call("agentic_set_policy", { rules: [{ target: target.address,
          selector: "0x12345678", token: zeroAddress, maxValueWei: "0", maxAmount: "0", decision: "DENY" }] });
        assert.equal(policyIntent.error, false);
        assert.equal(policyIntent.data.status, "OWNER_TRANSACTION_REQUIRED");
        assert.equal((policyIntent.data.transaction as { from: Address }).from.toLowerCase(), owner.account.address.toLowerCase());
        assert.equal(decodeFunctionData({ abi: agentPolicyAbi,
          data: (policyIntent.data.transaction as { data: Hex }).data }).functionName, "setPolicy");
        const rotation = await call("agentic_rotate_authenticator", { scheme: "secp256k1",
          address: privateKeyToAccount(generatePrivateKey()).address });
        assert.equal(rotation.error, false);
        assert.equal(rotation.data.status, "OWNER_TRANSACTION_REQUIRED");
        assert.equal(decodeFunctionData({ abi: agentAccountAbi,
          data: (rotation.data.transaction as { data: Hex }).data }).functionName, "rotateAuthenticator");
      }
      const challengeResponse = await fetch(`${serviceA.url}/agent/challenge`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: agent }) });
      assert.equal(challengeResponse.status, 200);
      const challenge = await challengeResponse.json() as Record<string, unknown>;
      const first = await call("agentic_session_proof", { challenge });
      if (phase === "revoked") {
        assert.equal(first.error, true);
        assert.equal(first.data.code, "AUTHENTICATOR_REVOKED");
      } else {
        assert.equal(first.error, false);
        const sendProof = (baseUrl: string, proof: Record<string, unknown>) => fetch(`${baseUrl}/agent/session`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(proof),
        });
        const crossProof = await sendProof(serviceB.url, first.data);
        assert.equal(crossProof.status, 401);
        const aAuth = await sendProof(serviceA.url, first.data);
        assert.equal(aAuth.status, 200);
        const aToken = aAuth.headers.get("Agent-Session");
        assert(aToken);
        const replay = await sendProof(serviceA.url, first.data);
        assert.equal(replay.status, 401);
        const aResource = await fetch(`${serviceA.url}/private/report`, { headers: { "Agent-Session": aToken } });
        assert.equal(aResource.status, 200);
        const bChallengeResponse = await fetch(`${serviceB.url}/agent/challenge`, { method: "POST",
          headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: agent }) });
        assert.equal(bChallengeResponse.status, 200);
        const bProof = await call("agentic_session_proof", { challenge: await bChallengeResponse.json() });
        assert.equal(bProof.error, false);
        const bAuth = await sendProof(serviceB.url, bProof.data);
        assert.equal(bAuth.status, 200);
        const bToken = bAuth.headers.get("Agent-Session");
        assert(bToken);
        const bResource = await fetch(`${serviceB.url}/private/compute`, { headers: { "Agent-Session": bToken } });
        assert.equal(bResource.status, 200);
        const forbidden = await fetch(`${serviceB.url}/private/admin`, { headers: { "Agent-Session": bToken } });
        assert.equal(forbidden.status, 403);
      }
      console.log(`MCP_RESULT ${JSON.stringify({ phase, agentId: agent, tools: tools.tools.length,
        status: phase === "revoked" ? first.data.code : "SESSION_ESTABLISHED" })}`);
    } finally { await mcp.close(); }
    if (phase === "active") {
      const launcher = join(temporary, "test-p256-signer");
      await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${signerFixtureScript}" "$@"\n`);
      await chmod(launcher, 0o700);
      await writeFile(configPath, JSON.stringify({ rpcUrl, chainId, factory: factory.address,
        implementation: await factory.read.implementation(), signer: { kind: "secure-enclave", binaryPath: launcher, label: "test-key" } }));
      const bootstrapTransport = new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", mcpScript],
        env: { ...process.env, AGENTIC_WORLD_CONFIG: configPath, AGENTIC_WORLD_OPERATING_KEY: "" } as Record<string, string> });
      const bootstrap = new Client({ name: "agentic-world-bootstrap-test", version: "0.1.0" });
      await bootstrap.connect(bootstrapTransport);
      try {
        const state = await bootstrap.callTool({ name: "agentic_identity", arguments: {} });
        const stateBlock = state.content?.[0];
        assert(stateBlock?.type === "text");
        assert.equal(JSON.parse(stateBlock.text).configured, false);
        const creation = await bootstrap.callTool({ name: "agentic_create_identity",
          arguments: { owner: owner.account.address, salt: generatePrivateKey() } });
        const creationBlock = creation.content?.[0];
        assert(creationBlock?.type === "text");
        assert.equal(creation.isError, undefined);
        const intent = JSON.parse(creationBlock.text) as { status: string; authenticator: { scheme: string }; transaction: { data: Hex } };
        assert.equal(intent.status, "OWNER_TRANSACTION_REQUIRED");
        assert.equal(intent.authenticator.scheme, "p256");
        assert.equal(decodeFunctionData({ abi: agentAccountFactoryAbi, data: intent.transaction.data }).functionName, "createAgentP256");
        console.log(`MCP_BOOTSTRAP ${JSON.stringify({ status: intent.status, scheme: intent.authenticator.scheme })}`);
      } finally { await bootstrap.close(); }
    }
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
