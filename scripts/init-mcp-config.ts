import { readFile, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SEPOLIA_CHAIN_ID } from "../sdk/deployments.js";
import { parseConfig } from "../mcp/server.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const defaultRpc = "https://ethereum-sepolia-rpc.publicnode.com";

export type InitOptions = {
  rpcUrl?: string;
  configPath?: string;
  signerBinaryPath?: string;
  platform?: NodeJS.Platform;
};

export async function initializeMcpConfig(options: InitOptions = {}): Promise<{ path: string; created: boolean }> {
  const platform = options.platform ?? process.platform;
  if (platform !== "darwin" && platform !== "win32") throw new Error("Local P-256 signing requires macOS Secure Enclave or Windows TPM");
  const rpcUrl = options.rpcUrl ?? defaultRpc;
  const rpc = new URL(rpcUrl);
  if (rpc.protocol !== "https:") throw new Error("Sepolia RPC must use HTTPS");
  const configPath = options.configPath ?? (platform === "darwin"
    ? join(homedir(), "Library/Application Support/AgenticWorld/config.json")
    : join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "AgenticWorld/config.json"));
  if (!isAbsolute(configPath)) throw new Error("MCP config path must be absolute");
  const signerBinaryPath = options.signerBinaryPath ?? resolve(root, `dist/signer/agentic-signer${platform === "win32" ? ".exe" : ""}`);
  if (!isAbsolute(signerBinaryPath) || !(await stat(signerBinaryPath)).isFile()) throw new Error("Build and verify the local signer before initializing MCP");
  try {
    await stat(configPath);
    let existing;
    try { existing = parseConfig(JSON.parse(await readFile(configPath, "utf8"))); }
    catch { throw new Error("Existing MCP config is invalid; leaving it unchanged"); }
    if (existing.chainId !== SEPOLIA_CHAIN_ID || !existing.signer)
      throw new Error("Existing MCP config is not a Sepolia hardware-signer config; leaving it unchanged");
    try {
      if (!(await stat(existing.signer.binaryPath)).isFile()) throw new Error("Signer is not a file");
    } catch { throw new Error("Existing MCP config points to a missing signer; leaving it unchanged"); }
    return { path: configPath, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return { path: configPath, created: false };
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const rpcIndex = process.argv.indexOf("--rpc");
  if (rpcIndex !== -1 && (!process.argv[rpcIndex + 1] || rpcIndex !== process.argv.length - 2))
    throw new Error("Usage: npm run init:mcp [-- --rpc https://your-sepolia-rpc]");
  if (rpcIndex === -1 && process.argv.length > 2) throw new Error("Usage: npm run init:mcp [-- --rpc https://your-sepolia-rpc]");
  const result = await initializeMcpConfig({ rpcUrl: rpcIndex === -1 ? undefined : process.argv[rpcIndex + 1] });
  process.stdout.write(`MCP_CONFIG_PATH=${result.path}\nMCP_CONFIG_${result.created ? "CREATED" : "EXISTS"}=true\n`);
}
