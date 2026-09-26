import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, parseAbiItem, type Address } from "viem";
import { startDemoService } from "../demo-service/server.js";
import { startDemoServiceB } from "../demo-service-b/server.js";
import { signerPublicKey } from "../mcp/local-signer.js";

const root = fileURLToPath(new URL("../", import.meta.url));
let rpcPort = 8545;
let servicePort = 8787;
let serviceBPort = 8797;
let rpcUrl = `http://127.0.0.1:${rpcPort}`;
const configPath = resolve(root, ".agentic-world.demo.json");
const statePath = resolve(root, ".agentic-world.demo-state.json");
const signerPath = resolve(root, `dist/signer/agentic-signer${process.platform === "win32" ? ".exe" : ""}`);
const hardhatPath = resolve(root, "node_modules/hardhat/dist/src/cli.js");
const signerLabel = process.env.AGENTIC_DEMO_SIGNER_LABEL ?? "agentic-world-demo";
const createdP256 = parseAbiItem("event AgentCreatedP256(address indexed agent,address indexed owner,bytes32 qx,bytes32 qy)");

type Deployment = { chainId: number; entryPoint: Address; factory: Address; implementation: Address;
  deploymentBlockNumber: string; deploymentBlockHash: string };
let node: ChildProcess | undefined;
let service: Awaited<ReturnType<typeof startDemoService>> | undefined;
let serviceB: Awaited<ReturnType<typeof startDemoServiceB>> | undefined;
let eventTimer: ReturnType<typeof setInterval> | undefined;
let stopping = false;
let runtimeDeployment: Deployment | undefined;
let runtimeAgent: Address | undefined;

async function run(command: string, args: string[], capture = false): Promise<string> {
  const windowsNpm = process.platform === "win32" && command === "npm";
  const child = spawn(windowsNpm ? (process.env.ComSpec ?? "cmd.exe") : command,
    windowsNpm ? ["/d", "/s", "/c", "npm run build:demo"] : args,
    { cwd: root, env: { ...process.env, DEMO_RPC_URL: rpcUrl },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
  let output = "";
  if (capture) {
    child.stdout?.on("data", chunk => { output += chunk.toString(); });
    child.stderr?.on("data", chunk => { output += chunk.toString(); });
  }
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", value => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code})${capture ? `:\n${output}` : ""}`);
  return output;
}

async function assertFree(port: number): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  }).catch(() => { throw new Error(`Port ${port} is occupied; stop the existing local service before npm run demo`); });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
}

async function firstFree(preferred: number, count = 16): Promise<number> {
  for (let port = preferred; port < preferred + count; port++) {
    try { await assertFree(port); return port; } catch { /* Try the next loopback port. */ }
  }
  throw new Error(`No free loopback port in ${preferred}–${preferred + count - 1}`);
}

async function waitForNode(child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Hardhat node exited early (${child.exitCode})`);
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(700) });
      const body = await response.json() as { result?: string };
      if (body.result === "0x7a69") return;
      if (body.result) throw new Error(`Expected chain 31337; got ${body.result}`);
    } catch { /* Node is starting. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("Hardhat node did not become ready within 20 seconds");
}

async function writeMcpConfig(deployment: Deployment, agentId?: Address): Promise<void> {
  const value = { rpcUrl, chainId: deployment.chainId, factory: deployment.factory,
    implementation: deployment.implementation, deploymentBlockNumber: deployment.deploymentBlockNumber,
    deploymentBlockHash: deployment.deploymentBlockHash, ...(agentId ? { agentId } : {}),
    signer: { kind: process.platform === "win32" ? "windows-tpm" : "secure-enclave", binaryPath: signerPath, label: signerLabel } };
  const temp = `${configPath}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, configPath);
}

function demoState(): object | undefined {
  if (!runtimeDeployment) return undefined;
  return { rpcUrl, serviceUrl: `http://127.0.0.1:${servicePort}`,
    audience: "https://service-a.example", serviceBUrl: `http://127.0.0.1:${serviceBPort}`,
    serviceBAudience: "https://service-b.example", chainId: runtimeDeployment.chainId,
    factory: runtimeDeployment.factory, implementation: runtimeDeployment.implementation,
    ...(runtimeAgent ? { agentId: runtimeAgent } : {}) };
}

async function writeDemoState(): Promise<void> {
  const value = demoState();
  if (!value) return;
  await writeFile(statePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function stop(exitCode = 0): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (eventTimer) clearInterval(eventTimer);
  if (serviceB) await serviceB.close().catch(() => {});
  if (service) await service.close().catch(() => {});
  if (node && node.exitCode === null) node.kill("SIGTERM");
  process.exitCode = exitCode;
}

process.once("SIGINT", () => { void stop(0); });
process.once("SIGTERM", () => { void stop(0); });

try {
  [rpcPort, servicePort, serviceBPort] = await Promise.all([firstFree(8545), firstFree(8787), firstFree(8797)]);
  rpcUrl = `http://127.0.0.1:${rpcPort}`;
  process.stdout.write("Building contracts, Service A, and Service B…\n");
  await run("npm", ["run", "build:demo"]);
  node = spawn(process.execPath, [hardhatPath, "node", "--hostname", "127.0.0.1", "--port", String(rpcPort)],
    { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let nodeOutput = "";
  const capture = (chunk: Buffer) => { nodeOutput = (nodeOutput + chunk.toString()).slice(-4000); };
  node.stdout?.on("data", capture); node.stderr?.on("data", capture);
  try { await waitForNode(node); }
  catch (error) { throw new Error(`${error instanceof Error ? error.message : String(error)}\n${nodeOutput}`); }
  process.stdout.write("Deploying EntryPoint and AgentAccountFactory…\n");
  const output = await run(process.execPath, [hardhatPath, "run", "--no-compile", "scripts/deploy-local-service.ts", "--network", "localhost"], true);
  const line = output.split("\n").find(item => item.startsWith("LOCAL_DEPLOYMENT "));
  if (!line) throw new Error(`Deployment did not return addresses:\n${output}`);
  const deployment = JSON.parse(line.slice("LOCAL_DEPLOYMENT ".length)) as Deployment;
  runtimeDeployment = deployment;
  const client = createPublicClient({ transport: http(rpcUrl) });
  if (deployment.chainId !== 31337 || await client.getChainId() !== 31337) throw new Error("Local chain mismatch");
  await writeMcpConfig(deployment);
  service = await startDemoService({ client, chainId: deployment.chainId, implementation: deployment.implementation,
    audience: "https://service-a.example", port: servicePort });
  serviceB = await startDemoServiceB({ client, chainId: deployment.chainId, implementation: deployment.implementation,
    audience: "https://service-b.example", port: serviceBPort });
  await writeDemoState();
  let cursor = await client.getBlockNumber({ cacheTime: 0 });
  let selectedAgent: Address | undefined;
  let operatingPublicKey: Awaited<ReturnType<typeof signerPublicKey>> | undefined;
  let checking = false;
  eventTimer = setInterval(async () => {
    if (checking || selectedAgent || stopping) return;
    checking = true;
    try {
      operatingPublicKey ??= await signerPublicKey({ binaryPath: signerPath, label: signerLabel }).catch(() => undefined);
      const key = operatingPublicKey;
      if (!key) return;
      const latest = await client.getBlockNumber({ cacheTime: 0 });
      if (latest <= cursor) return;
      const logs = await client.getLogs({ address: deployment.factory, event: createdP256,
        fromBlock: cursor + 1n, toBlock: latest });
      cursor = latest;
      const agent = logs.find(log => log.args.qx?.toLowerCase() === key.qx.toLowerCase() &&
        log.args.qy?.toLowerCase() === key.qy.toLowerCase())?.args.agent;
      if (agent) {
        selectedAgent = agent;
        runtimeAgent = agent;
        await writeMcpConfig(deployment, agent);
        await writeDemoState();
        process.stdout.write(`\nAgent ${agent} detected. Demo MCP config updated; start a new Codex session to load it.\n`);
      }
    } catch (error) { process.stderr.write(`Agent discovery retry: ${error instanceof Error ? error.message : String(error)}\n`); }
    finally { checking = false; }
  }, 3000);
  node.once("exit", code => { if (!stopping) { process.stderr.write(`Hardhat node stopped (${code}). Shutting down demo.\n`); void stop(1); } });
  process.stdout.write(`\nAGENTIC WORLD DEMO READY\nService A (manual agent registration): ${service.baseUrl}\nService B (register your wallet):     ${serviceB.baseUrl}\nOperator key for Service A:          ${service.operatorToken}\nChain:                               ${rpcUrl} (31337)\nFactory:                             ${deployment.factory}\nImplementation:                      ${deployment.implementation}\nMCP config:                          ${configPath}\nAgent discovery:                     ${statePath}\n\n`);
  process.stdout.write(`The repo skill is already at .agents/skills/agentic-world/SKILL.md. MCP and signer setup are separate from this demo:\n`);
  process.stdout.write("npm run build:mcp\nnpm run build:signer\n");
  process.stdout.write(`Then register MCP in Codex once:\n`);
  process.stdout.write(`codex mcp add agentic-world --env AGENTIC_WORLD_CONFIG=${configPath} -- node ${resolve(root, "dist/mcp/server.js")}\n\n`);
  process.stdout.write(`The first no-argument agentic_create_identity call creates or reuses the ${process.platform === "win32" ? "TPM" : "Secure Enclave"} key '${signerLabel}'.\n`);
  process.stdout.write("Ask the skill to create your identity. Its one-time localhost page opens your browser; connect your owner wallet and confirm the factory transaction. Ctrl+C stops the demo.\n");
} catch (error) {
  process.stderr.write(`Demo startup failed: ${error instanceof Error ? error.message : String(error)}\n`);
  await stop(1);
}
