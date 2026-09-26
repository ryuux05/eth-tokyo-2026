import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";
import { parseConfig } from "./server.js";

type RpcReader = (url: string, method: string) => Promise<unknown>;

async function readRpc(url: string, method: string): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: method, method, params: [] }),
  });
  if (!response.ok) throw new Error("Bundler request failed");
  const value = await response.json() as { jsonrpc?: string; id?: string; result?: unknown; error?: unknown };
  if (value.jsonrpc !== "2.0" || value.id !== method || value.error || value.result === undefined)
    throw new Error("Invalid bundler response");
  return value.result;
}

/** Read-only checks. Never sign, estimate, or submit a UserOperation here. */
export async function validateBundler(url: string, request: RpcReader = readRpc): Promise<void> {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new Error();
  } catch { throw new Error("Bundler RPC must be a valid HTTPS URL without userinfo or a fragment"); }
  let chain: unknown, entries: unknown, prices: unknown;
  try {
    [chain, entries, prices] = await Promise.all([
      request(url, "eth_chainId"), request(url, "eth_supportedEntryPoints"),
      request(url, "pimlico_getUserOperationGasPrice"),
    ]);
  } catch {
    // Providers and transports can put the credential-bearing URL in errors.
    throw new Error("Could not validate the bundler. Check the URL, credentials and Pimlico API support; config was not changed");
  }
  if (typeof chain !== "string" || !/^0x[0-9a-f]+$/i.test(chain) || BigInt(chain) !== BigInt(SEPOLIA_CHAIN_ID))
    throw new Error("Bundler must report Sepolia chain ID 11155111; config was not changed");
  if (!Array.isArray(entries) || !entries.some(value => typeof value === "string" && value.toLowerCase() === SEPOLIA_DEPLOYMENT.entryPoint.toLowerCase()))
    throw new Error("Bundler must support the pinned EntryPoint v0.8; config was not changed");
  const standard = (prices as { standard?: { maxFeePerGas?: unknown; maxPriorityFeePerGas?: unknown } } | null)?.standard;
  const fee = standard?.maxFeePerGas, tip = standard?.maxPriorityFeePerGas;
  if (typeof fee !== "string" || typeof tip !== "string" || !/^0x[0-9a-f]+$/i.test(fee) || !/^0x[0-9a-f]+$/i.test(tip) ||
      BigInt(fee) <= 0n || BigInt(tip) > BigInt(fee))
    throw new Error("Bundler returned an unsupported Pimlico gas-price response; config was not changed");
}

export async function configureBundler(options: { configPath: string; bundlerRpcUrl: string; request?: RpcReader }) {
  const { configPath, bundlerRpcUrl } = options;
  if (!isAbsolute(configPath)) throw new Error("MCP config path must be absolute");
  let original: string;
  try { original = await readFile(configPath, "utf8"); }
  catch { throw new Error("Cannot read the MCP config. Run init first or select its existing path with --config"); }
  let document: Record<string, any>;
  try {
    document = JSON.parse(original);
    const config = parseConfig(document);
    if (config.chainId !== SEPOLIA_CHAIN_ID || !config.signer) throw new Error();
  } catch { throw new Error("Existing config must be a valid Sepolia hardware-signer config; left unchanged"); }
  const lockPath = `${configPath}.bundler.lock`;
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch { throw new Error("Bundler configuration is locked. Wait for the other command; remove a stale .bundler.lock only after it has stopped"); }
  const temporary = `${configPath}.${randomUUID()}.tmp`;
  try {
    await validateBundler(bundlerRpcUrl, options.request);
    const next = { ...document, execution: { ...document.execution, bundlerRpcUrl } };
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (await readFile(configPath, "utf8") !== original)
      throw new Error("MCP config changed during setup. Stop the MCP and retry; config was not overwritten");
    await rename(temporary, configPath);
    return { configured: true, chainId: SEPOLIA_CHAIN_ID, entryPoint: SEPOLIA_DEPLOYMENT.entryPoint };
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

export function parseBundlerArguments(args: string[]) {
  const options: { url?: string; config?: string; help?: boolean } = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if ((arg === "--bundler-rpc" || arg === "--config") && args[i + 1] && !args[i + 1].startsWith("--")) {
      const key = arg === "--bundler-rpc" ? "url" : "config";
      if (options[key] !== undefined) throw new Error("Repeated configure-bundler option");
      options[key] = args[++i];
    } else throw new Error("Unknown or incomplete configure-bundler argument. Run configure-bundler --help");
  }
  return options;
}

async function promptUrl(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("Set AGENTIC_WORLD_BUNDLER_RPC_URL or run configure-bundler in your own terminal for a hidden URL prompt");
  // readline keeps editing/paste behavior while its terminal output is muted.
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const input = createInterface({ input: process.stdin, output, terminal: true });
  const cancellation = new AbortController();
  input.on("SIGINT", () => cancellation.abort());
  input.on("close", () => cancellation.abort());
  process.stdout.write("Pimlico Sepolia RPC URL (hidden): ");
  try { return (await input.question("", { signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(300000)]) })).trim(); }
  catch { throw new Error("Bundler setup cancelled; config was not changed"); }
  finally { input.close(); process.stdout.write("\n"); }
}

export async function runBundlerConfiguration(args = process.argv.slice(2), env = process.env) {
  const options = parseBundlerArguments(args);
  if (options.help) {
    process.stdout.write("Usage: agenticworld configure-bundler [--config <absolute-path>] [--bundler-rpc <https-url>]\nStop the MCP first; restart it after saving. With no URL, uses AGENTIC_WORLD_BUNDLER_RPC_URL or a hidden terminal prompt.\n");
    return;
  }
  const configPath = options.config ?? env.AGENTIC_WORLD_CONFIG ?? (process.platform === "darwin"
    ? join(homedir(), "Library/Application Support/AgenticWorld/config.json")
    : process.platform === "win32" ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData/Local"), "AgenticWorld/config.json") : undefined);
  if (!configPath) throw new Error("Provide --config or AGENTIC_WORLD_CONFIG for the existing MCP config");
  process.stdout.write("Configure the bundler after stopping/disconnecting the MCP.\n");
  const bundlerRpcUrl = options.url ?? env.AGENTIC_WORLD_BUNDLER_RPC_URL ?? await promptUrl();
  if (!bundlerRpcUrl.trim()) throw new Error("Bundler URL is required; config was not changed");
  const result = await configureBundler({ configPath, bundlerRpcUrl: bundlerRpcUrl.trim() });
  process.stdout.write(`Bundler configured for Sepolia (${result.chainId}), EntryPoint v0.8. Restart the MCP to use it.\nIdentities, keys, chain RPC and gas limits were preserved. No transaction was signed or sent.\n`);
}
