import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { openDefaultBrowser } from "./open-browser.js";
import { FlowCancelledError, FlowInterruptedError, watchApprovalPage } from "./flow-cancel.js";

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
  disconnectGraceMs?: number;
  signal?: AbortSignal;
};

/** One-time loopback approval; only the owner wallet can submit the prepared transaction. */
export async function runOwnerActionFlow<T>(options: Options<T>): Promise<{ hash: Hex; state: T }> {
  const token = randomBytes(24).toString("hex");
  const html = await readFile(fileURLToPath(new URL("./owner-action-page.html", import.meta.url)), "utf8")
    .catch(() => readFile(fileURLToPath(new URL("../../mcp/owner-action-page.html", import.meta.url)), "utf8"));
  let base = "";
  let confirming = false;
  let confirmed = false;
  let submittedHash: Hex | undefined;
  let settle: (value: { hash: Hex; state: T }) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const outcome = new Promise<{ hash: Hex; state: T }>((resolve, reject) => { settle = resolve; fail = reject; });
  void outcome.catch(() => {});
  const lifecycle = watchApprovalPage(() => {
    if (confirming || confirmed) return;
    fail(submittedHash || lifecycle.walletPending ? new FlowInterruptedError(submittedHash) : new FlowCancelledError());
  }, options.disconnectGraceMs);
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; frame-ancestors 'none'" });
      response.end(JSON.stringify(value));
    };
    if (request.headers.host !== base.slice(7) || !request.url?.startsWith(`/flow/${token}`)) { send(404, { error: "Not found" }); return; }
    if (lifecycle.handle(request, response, `/flow/${token}`, base)) return;
    if (request.url === `/flow/${token}` && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "no-referrer",
        "content-security-policy": "default-src 'none'; script-src 'nonce-agentic-owner'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
      response.end(html.replace('<script type="module">', '<script type="module" nonce="agentic-owner">'));
      return;
    }
    if (request.url === `/flow/${token}/context` && request.method === "GET") {
      const rpc = new URL(options.rpcUrl);
      send(200, { ...options.intent, chainName: options.intent.transaction.chainId === 31337 ? "Agentic World local" : options.intent.transaction.chainId === 11155111 ? "Ethereum Sepolia" : "Ethereum network",
        deploymentBlockNumber: options.deploymentBlockNumber, deploymentBlockHash: options.deploymentBlockHash,
        localRpcUrl: ["127.0.0.1", "localhost"].includes(rpc.hostname) ? options.rpcUrl : undefined, submittedHash,
        walletPending: lifecycle.walletPending });
      return;
    }
    if (request.url === `/flow/${token}/cancel` && request.method === "POST" && request.headers.origin === base) {
      if (submittedHash || confirming || confirmed) { send(409, { error: "A transaction was submitted. Closing this page cannot cancel it; check its hash before retrying." }); return; }
      response.once("finish", () => fail(lifecycle.walletPending ? new FlowInterruptedError() : new FlowCancelledError()));
      send(200, { cancelled: true });
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
      if (submittedHash && submittedHash.toLowerCase() !== body.hash.toLowerCase()) { send(409, { error: "A different transaction was already submitted" }); return; }
      submittedHash = body.hash as Hex;
      confirming = true;
      try {
        const hash = body.hash as Hex;
        const state = await options.confirm(hash);
        confirmed = true;
        send(200, { hash, state });
        if (response.destroyed) settle({ hash, state });
        else response.once("finish", () => settle({ hash, state }));
        response.once("close", () => settle({ hash, state }));
      } finally { confirming = false; }
    } catch (error) {
      send(400, { error: error instanceof Error ? error.message : "Confirmation failed" });
      if (lifecycle.detached) fail(new FlowInterruptedError(submittedHash));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not bind local owner approval page");
  base = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(() => fail(submittedHash || lifecycle.walletPending ? new FlowInterruptedError(submittedHash)
    : new FlowCancelledError()), options.timeoutMs ?? 300_000);
  const abort = () => {
    // A broadcast transaction is independent of the cancelled MCP call.
    // Continue its confirmation so a successful creation is still saved.
    if (submittedHash) return;
    fail(lifecycle.walletPending ? new FlowInterruptedError() : new FlowCancelledError());
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted) abort();
    else await (options.openBrowser ?? openDefaultBrowser)(`${base}/flow/${token}`);
    return await outcome;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    lifecycle.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
