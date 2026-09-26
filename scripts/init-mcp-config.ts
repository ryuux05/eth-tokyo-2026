import { readFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SEPOLIA_CHAIN_ID } from "../sdk/deployments.js";
import { parseConfig } from "../mcp/server.js";
import { createPublicClient, http } from "viem";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaultRpc = "https://ethereum-sepolia-rpc.publicnode.com";

export type InitOptions = {
  rpcUrl?: string;
  configPath?: string;
  signerBinaryPath?: string;
  platform?: NodeJS.Platform;
  updateRpc?: boolean;
  /** Read-only RPC adapter for isolated tests. Never read from user config. */
  readChainId?: (rpcUrl: string) => Promise<number>;
};

export async function initializeMcpConfig(options: InitOptions = {}): Promise<{ path: string; created: boolean; rpcUpdated?: boolean }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("Local P-256 signing requires macOS Secure Enclave or Windows TPM");
  const rpcUrl = options.rpcUrl ?? defaultRpc;
  let rpc: URL;
  try { rpc = new URL(rpcUrl); }
  catch { throw new Error("Sepolia RPC must be a valid HTTPS URL"); }
  if (rpc.protocol !== "https:") throw new Error("Sepolia RPC must use HTTPS");
  if (options.updateRpc && !options.rpcUrl) throw new Error("RPC update requires an explicit --rpc URL or AGENTIC_WORLD_RPC_URL");
  async function validateRpc() {
    let chainId: number;
    try {
      chainId = await (options.readChainId ?? (url => createPublicClient({ transport: http(url, { timeout: 8000, retryCount: 0 }) }).getChainId()))(rpcUrl);
    } catch { throw new Error("Could not verify the RPC chain. Check the endpoint and credentials; config was not changed"); }
    if (chainId !== SEPOLIA_CHAIN_ID) throw new Error("RPC must return Sepolia chain ID 11155111; config was not changed");
  }
  const configPath = options.configPath ?? (platform === "darwin"
    ? join(homedir(), "Library/Application Support/AgenticWorld/config.json")
    : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "AgenticWorld/config.json"));
  if (!isAbsolute(configPath)) throw new Error("MCP config path must be absolute");
  const signerBinaryPath = options.signerBinaryPath ?? resolve(root, `dist/signer/agentic-signer${platform === "win32" ? ".exe" : ""}`);
  if (!isAbsolute(signerBinaryPath) || !(await stat(signerBinaryPath)).isFile()) throw new Error("Build and verify the local signer before initializing MCP");
  try {
    await stat(configPath);
    let existing;
    const original = await readFile(configPath, "utf8");
    try { existing = parseConfig(JSON.parse(original)); }
    catch { throw new Error("Existing MCP config is invalid; leaving it unchanged"); }
    if (existing.chainId !== SEPOLIA_CHAIN_ID || !existing.signer)
      throw new Error("Existing MCP config is not a Sepolia hardware-signer config; leaving it unchanged");
    try {
      if (!(await stat(existing.signer.binaryPath)).isFile()) throw new Error("Signer is not a file");
    } catch { throw new Error("Existing MCP config points to a missing signer; leaving it unchanged"); }
    if (options.rpcUrl && new URL(existing.rpcUrl).href !== rpc.href) {
      if (!options.updateRpc) throw new Error("Existing config uses a different RPC. Stop the MCP, then rerun with --rpc <url> --update-rpc to change only the endpoint");
      await validateRpc();
      const temporary = `${configPath}.${randomUUID()}.tmp`;
      try {
        // Preserve the original document, not parseConfig's normalized defaults.
        await writeFile(temporary, `${JSON.stringify({ ...JSON.parse(original), rpcUrl }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        if (await readFile(configPath, "utf8") !== original) throw new Error("MCP config changed during RPC update; stop the MCP and retry");
        await rename(temporary, configPath);
      } finally { await rm(temporary, { force: true }); }
      return { path: configPath, created: false, rpcUpdated: true };
    }
    return { path: configPath, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (options.updateRpc) throw new Error("No existing MCP config to update; run init without --update-rpc first");
  await validateRpc();
  await mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const config = {
    rpcUrl,
    chainId: SEPOLIA_CHAIN_ID,
    signer: { kind: platform === "darwin" ? "secure-enclave" : "windows-tpm", binaryPath: signerBinaryPath, label: "agentic-world-sepolia" },
  };
  try {
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    return { path: configPath, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Another init created the config; rerun to verify its settings");
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    let rpcUrl: string | undefined;
    let updateRpc = false;
    const usage = "Usage: npm run init:mcp [-- --rpc <https-url> [--update-rpc]]; AGENTIC_WORLD_RPC_URL may supply the URL privately";
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--rpc" && rpcUrl === undefined && args[i + 1] && !args[i + 1].startsWith("--")) rpcUrl = args[++i];
      else if (args[i] === "--update-rpc" && !updateRpc) updateRpc = true;
      else throw new Error(usage);
    }
    const result = await initializeMcpConfig({ rpcUrl: rpcUrl ?? process.env.AGENTIC_WORLD_RPC_URL, updateRpc });
    process.stdout.write(`MCP_CONFIG_PATH=${result.path}\nMCP_CONFIG_${result.created ? "CREATED" : result.rpcUpdated ? "RPC_UPDATED" : "EXISTS"}=true\n`);
    if (result.rpcUpdated) process.stdout.write("Restart the MCP to use the new endpoint. Identities and signer settings were preserved.\n");
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "MCP init failed"}\n`);
    process.exitCode = 1;
  }
}
