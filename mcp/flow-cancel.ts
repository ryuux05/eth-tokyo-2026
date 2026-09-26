import type { IncomingMessage, ServerResponse } from "node:http";

export class FlowCancelledError extends Error {
  constructor() {
    super("Owner closed the approval page before submitting a transaction");
    this.name = "FlowCancelledError";
  }
}

export class FlowInterruptedError extends Error {
  constructor(readonly transactionHash?: string) {
    super(transactionHash
      ? `Approval page closed. Transaction ${transactionHash} may still complete; check this hash before retrying. Closing a page does not cancel an onchain transaction.`
      : "Approval page closed while the wallet request was unresolved. Reject any outstanding wallet prompt and check wallet activity before retrying. No transaction hash was received.");
    this.name = "FlowInterruptedError";
  }
}

/** An open stream survives background tabs, unlike heartbeat timers. A short
 * disconnect grace allows refresh/navigation back without cancelling the flow. */
export function watchApprovalPage(onDisconnect: () => void, disconnectGraceMs = 1500) {
  const streams = new Set<ServerResponse>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let detached = false;
  let walletPending = false;
  const disconnected = () => {
    clearTimeout(timer);
    if (!disposed && streams.size === 0) timer = setTimeout(() => {
      detached = true;
      onDisconnect();
    }, disconnectGraceMs);
  };
  return {
    get detached() { return detached; },
    get walletPending() { return walletPending; },
    handle(request: IncomingMessage, response: ServerResponse, prefix: string, base: string): boolean {
      if (request.url === `${prefix}/events` && request.method === "GET") {
        if ((request.headers.origin && request.headers.origin !== base) ||
            (request.headers["sec-fetch-site"] && request.headers["sec-fetch-site"] !== "same-origin")) {
          response.writeHead(403); response.end(); return true;
        }
        clearTimeout(timer);
        detached = false;
        streams.add(response);
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store",
          "x-content-type-options": "nosniff" });
        response.write("retry: 500\ndata: connected\n\n");
        const heartbeat = setInterval(() => response.write(": alive\n\n"), 10_000);
        response.once("close", () => { clearInterval(heartbeat); streams.delete(response); disconnected(); });
        return true;
      }
      if (request.url === `${prefix}/wallet` && request.method === "POST" && request.headers.origin === base) {
        const state = request.headers["x-agentic-wallet-state"];
        if (state !== "pending" && state !== "rejected") { response.writeHead(400); response.end(); return true; }
        walletPending = state === "pending";
        response.writeHead(204, { "cache-control": "no-store" }); response.end();
        return true;
      }
      return false;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      for (const stream of streams) stream.end();
    },
  };
}
