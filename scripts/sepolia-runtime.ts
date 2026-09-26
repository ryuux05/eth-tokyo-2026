import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createPublicClient, http, type PublicClient } from "viem";
import { agentAccountFactoryAbi } from "../sdk/core.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";

const defaultRpc = "https://ethereum-sepolia-rpc.publicnode.com";

function requireHttpsSepoliaRpc(value: unknown): string {
  if (typeof value !== "string") throw new Error("Sepolia RPC URL is missing");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Sepolia RPC must be an HTTPS URL without embedded credentials");
  return url.toString();
}

/** Reuse the MCP's private config when present; never read the old Hardhat demo config implicitly. */
export async function resolveSepoliaRpcUrl(environment: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (environment.AGENTIC_SEPOLIA_RPC_URL) return requireHttpsSepoliaRpc(environment.AGENTIC_SEPOLIA_RPC_URL);
  const configuredPath = environment.AGENTIC_WORLD_CONFIG;
  const defaultPath = process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/AgenticWorld/config.json")
    : process.platform === "win32"
      ? join(environment.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "AgenticWorld/config.json")
      : undefined;
  const path = configuredPath ?? defaultPath;
  if (!path) return defaultRpc;
  let bytes: string;
  try { bytes = await readFile(path, "utf8"); }
  catch (error) {
    if (!configuredPath && (error as NodeJS.ErrnoException).code === "ENOENT") return defaultRpc;
    throw new Error("Could not read the configured Agentic World MCP file");
  }
  let config: unknown;
  try { config = JSON.parse(bytes); }
  catch { throw new Error("Agentic World MCP config is not valid JSON"); }
  if (!config || typeof config !== "object" || !("chainId" in config) || config.chainId !== SEPOLIA_CHAIN_ID ||
      !("rpcUrl" in config)) throw new Error("Agentic World MCP config must target Sepolia chain 11155111");
  return requireHttpsSepoliaRpc(config.rpcUrl);
}

/** Refuse to start a service against the wrong chain or a different factory/module deployment. */
export async function verifySepoliaDeployment(client: PublicClient): Promise<void> {
  if (await client.getChainId() !== SEPOLIA_CHAIN_ID) throw new Error("RPC is not Sepolia chain 11155111");
  const [factoryCode, implementationCode, entryPointCode, implementation, validator, policyHook] = await Promise.all([
    client.getBytecode({ address: SEPOLIA_DEPLOYMENT.factory }),
    client.getBytecode({ address: SEPOLIA_DEPLOYMENT.implementation }),
    client.getBytecode({ address: SEPOLIA_DEPLOYMENT.entryPoint }),
    client.readContract({ address: SEPOLIA_DEPLOYMENT.factory, abi: agentAccountFactoryAbi, functionName: "implementation" }),
    client.readContract({ address: SEPOLIA_DEPLOYMENT.factory, abi: agentAccountFactoryAbi, functionName: "validator" }),
    client.readContract({ address: SEPOLIA_DEPLOYMENT.factory, abi: agentAccountFactoryAbi, functionName: "policyHook" }),
  ]);
  if (!factoryCode || factoryCode === "0x" || !implementationCode || implementationCode === "0x" || !entryPointCode || entryPointCode === "0x" ||
      implementation.toLowerCase() !== SEPOLIA_DEPLOYMENT.implementation.toLowerCase() ||
      validator.toLowerCase() !== SEPOLIA_DEPLOYMENT.validator.toLowerCase() ||
      policyHook.toLowerCase() !== SEPOLIA_DEPLOYMENT.policyHook.toLowerCase()) {
    throw new Error("Sepolia contracts do not match the pinned Agentic World deployment");
  }
}

export async function createVerifiedSepoliaClient(rpcUrl: string): Promise<PublicClient> {
  const client = createPublicClient({ transport: http(requireHttpsSepoliaRpc(rpcUrl), { timeout: 15_000, retryCount: 1 }) });
  await verifySepoliaDeployment(client);
  return client;
}
