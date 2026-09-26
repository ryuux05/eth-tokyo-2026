import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";

export type OwnerActionIntent = {
  action: "policy" | "rotate" | "revoke";
  agentId: Address;
  summary: string;
  details: string[];
  transaction: { chainId: number; from: Address; to: Address; value: string; data: Hex };
};

type Options<T> = {
  intent: OwnerActionIntent;
  rpcUrl: string;
  deploymentBlockNumber?: string;
  deploymentBlockHash?: Hex;
  confirm: (hash: Hex) => Promise<T>;
  openBrowser?: (url: string) => Promise<void>;
  timeoutMs?: number;
};

async function openDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : undefined;
  if (!command) throw new Error("Automatic browser opening currently requires macOS or Windows");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error("Could not open the default browser")));
  });
}

/** One-time loopback approval; only the owner wallet can submit the prepared transaction. */
export async function runOwnerActionFlow<T>(options: Options<T>): Promise<{ hash: Hex; state: T }> {
  const token = randomBytes(24).toString("hex");
  const html = await readFile(fileURLToPath(new URL("./owner-action-page.html", import.meta.url)), "utf8")
    .catch(() => readFile(fileURLToPath(new URL("../../mcp/owner-action-page.html", import.meta.url)), "utf8"));
  let base = "";
  let confirming = false;
  let confirmed = false;
  let settle: (value: { hash: Hex; state: T }) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const outcome = new Promise<{ hash: Hex; state: T }>((resolve, reject) => { settle = resolve; fail = reject; });
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.host !== base.slice(7) || !request.url?.startsWith(`/flow/${token}`)) { send(404, { error: "Not found" }); return; }
    if (request.url === `/flow/${token}` && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'nonce-agentic-owner'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(html.replace('<script type="module">', '<script type="module" nonce="agentic-owner">'));
      return;
    }
    if (request.url === `/flow/${token}/context` && request.method === "GET") {
      const rpc = new URL(options.rpcUrl);
      send(200, { ...options.intent, chainName: options.intent.transaction.chainId === 31337 ? "Agentic World local" : `Chain ${options.intent.transaction.chainId}`,
        deploymentBlockNumber: options.deploymentBlockNumber, deploymentBlockHash: options.deploymentBlockHash,
        localRpcUrl: ["127.0.0.1", "localhost"].includes(rpc.hostname) ? options.rpcUrl : undefined });
      return;
    }
    if (request.url !== `/flow/${token}/complete` || request.method !== "POST" || request.headers.origin !== base ||
        !request.headers["content-type"]?.startsWith("application/json")) { send(403, { error: "Request rejected" }); return; }
    let data = "";
    for await (const chunk of request) {
      data += chunk.toString();
      if (data.length > 1024) { send(413, { error: "Request too large" }); return; }
    }
    if (confirming || confirmed) { send(409, { error: "Transaction confirmation already in progress or completed" }); return; }
    try {
      const body = JSON.parse(data) as Record<string, unknown>;
      if (typeof body.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.hash)) { send(400, { error: "Invalid transaction hash" }); return; }
      confirming = true;
      try {
        const hash = body.hash as Hex;
        const state = await options.confirm(hash);
        confirmed = true;
        response.once("finish", () => settle({ hash, state }));
        send(200, { hash, state });
      } finally { confirming = false; }
    } catch (error) { send(400, { error: error instanceof Error ? error.message : "Confirmation failed" }); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local owner approval page");
  base = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(() => fail(new Error("Owner approval timed out; check whether a wallet transaction is still pending")), options.timeoutMs ?? 300_000);
  try {
    await (options.openBrowser ?? openDefaultBrowser)(`${base}/flow/${token}`);
    return await outcome;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
