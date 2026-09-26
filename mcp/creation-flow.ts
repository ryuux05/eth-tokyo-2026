import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

export type CreationIntent = { predictedAgent: Address; transaction: { chainId: number; from: Address; to: Address; value: string; data: Hex } };

type FlowOptions = {
  chainId: number; factory: Address; rpcUrl: string; qx: Hex; qy: Hex;
  deploymentBlockNumber?: string; deploymentBlockHash?: Hex;
  prepare: (owner: string) => Promise<CreationIntent>;
  confirm: (hash: Hex, intent: CreationIntent) => Promise<Address>;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
};

async function defaultOpenBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : undefined;
  if (!command) throw new Error("Automatic browser opening currently requires macOS or Windows");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Could not open the default browser")));
  });
}

/** A single-use, loopback-only wallet approval page. Its secret URL never leaves MCP. */
export async function runCreationFlow(options: FlowOptions): Promise<Address> {
  const token = randomBytes(24).toString("hex");
  const html = await readFile(fileURLToPath(new URL("./creation-page.html", import.meta.url)), "utf8")
    .catch(() => readFile(fileURLToPath(new URL("../../mcp/creation-page.html", import.meta.url)), "utf8"));
  let base = "";
  let intent: CreationIntent | undefined;
  let preparing = false;
  let inFlight = false;
  let settle: (value: Address) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const outcome = new Promise<Address>((resolve, reject) => { settle = resolve; fail = reject; });
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.host !== base.slice("http://".length) || !request.url?.startsWith(`/flow/${token}`)) { send(404, { error: "Not found" }); return; }
    const path = request.url;
    if (path === `/flow/${token}` && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; script-src 'nonce-agentic-creation'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(html.replace('<script type="module">', '<script type="module" nonce="agentic-creation">'));
      return;
    }
    if (path === `/flow/${token}/context` && request.method === "GET") {
      const rpc = new URL(options.rpcUrl);
      send(200, { chainId: options.chainId, chainName: options.chainId === 31337 ? "Agentic World local" : `Chain ${options.chainId}`,
        factory: options.factory, qx: options.qx, qy: options.qy,
        deploymentBlockNumber: options.deploymentBlockNumber, deploymentBlockHash: options.deploymentBlockHash,
        localRpcUrl: ["127.0.0.1", "localhost"].includes(rpc.hostname) ? options.rpcUrl : undefined });
      return;
    }
    if (request.method !== "POST" || ![`/flow/${token}/prepare`, `/flow/${token}/complete`].includes(path) ||
        request.headers.origin !== base || !request.headers["content-type"]?.startsWith("application/json")) { send(403, { error: "Request rejected" }); return; }
    let data = "";
    for await (const chunk of request) {
      data += chunk.toString();
      if (data.length > 1024) { send(413, { error: "Request too large" }); return; }
    }
    try {
      const body = JSON.parse(data) as Record<string, unknown>;
      if (path.endsWith("/prepare")) {
        if (intent || preparing) { send(409, { error: "Owner already selected; reload the flow to start over" }); return; }
        if (typeof body.owner !== "string") { send(400, { error: "Select an owner wallet" }); return; }
        preparing = true;
        try { intent = await options.prepare(body.owner); }
        finally { preparing = false; }
        send(200, intent);
      } else {
        if (!intent || inFlight) { send(409, { error: "No pending owner transaction" }); return; }
        if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) { send(400, { error: "Invalid transaction hash" }); return; }
        inFlight = true;
        try {
          const agentId = await options.confirm(body.hash as Hex, intent);
          response.once("finish", () => settle(agentId));
          send(200, { agentId });
        } finally { inFlight = false; }
      }
    } catch (error) { send(400, { error: error instanceof Error ? error.message : "Creation failed" }); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local creation page");
  base = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(() => fail(new Error("Identity creation timed out; call the tool again to retry")), options.timeoutMs ?? 300_000);
  try {
    await (options.openBrowser ?? defaultOpenBrowser)(`${base}/flow/${token}`);
    return await outcome;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
