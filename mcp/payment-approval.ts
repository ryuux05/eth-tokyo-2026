import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Hex, Address } from "viem";
import type { ownerActionTypedData } from "../sdk/policy.js";
import type { PaymentIntent } from "../sdk/payments.js";
import { openDefaultBrowser } from "./open-browser.js";
import { watchApprovalPage } from "./flow-cancel.js";

/** Owner signatures, never wallet private keys, cross this one-time loopback flow. */
export async function approvePayment(options: {
  owner: Address; typedData: ReturnType<typeof ownerActionTypedData>; intent: PaymentIntent;
  verify(signature: Hex): Promise<boolean>; openBrowser?: (url: string) => Promise<void>; signal?: AbortSignal;
}): Promise<Hex> {
  const token = randomBytes(24).toString("hex");
  const path = `/flow/${token}`;
  const html = await readFile(new URL("./owner-action-page.html", import.meta.url), "utf8")
    .catch(() => readFile(new URL("../../mcp/owner-action-page.html", import.meta.url), "utf8"));
  let base = "";
  let settled = false;
  let verifying = false;
  let succeed!: (signature: Hex) => void;
  let fail!: (error: Error) => void;
  const outcome = new Promise<Hex>((resolve, reject) => { succeed = resolve; fail = reject; });
  void outcome.catch(() => {});
  const cancel = () => { if (!settled) { settled = true; fail(new Error("PAYMENT_CANCELLED: owner approval closed or expired; no UserOperation was submitted")); } };
  const lifecycle = watchApprovalPage(cancel);
  const server = createServer(async (request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
    };
    if (request.headers.host !== base.slice(7) || !request.url?.startsWith(path)) { send(404, {}); return; }
    if (lifecycle.handle(request, response, path, base)) return;
    if (request.url === path && request.method === "GET") {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store", "referrer-policy": "no-referrer",
        "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; script-src 'nonce-agentic-owner'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" });
      response.end(html.replace('<script type="module">', '<script type="module" nonce="agentic-owner">')); return;
    }
    if (request.url === `${path}/context` && request.method === "GET") {
      send(200, { action: "payment", agentId: options.intent.agentId, typedData: options.typedData,
        amount: options.intent.amount, recipient: options.intent.recipient, kind: options.intent.kind ?? "transfer", deadline: Number(options.typedData.message.deadline),
        summary: options.intent.kind === "allowance"
          ? `Authorize a bounded allowance of exactly ${options.intent.amount} USDC for this Service C contract. This sets its spending allowance; it does not purchase credits. Unspent allowance remains until used or revoked.`
          : options.intent.kind === "purchase"
          ? `Authorize this agent to purchase compute for exactly ${options.intent.amount} USDC from the displayed Service C contract.`
          : `Authorize this agent to send exactly ${options.intent.amount} USDC. Your wallet signs an approval; the agent then submits the payment.`,
        chainName: options.typedData.domain.chainId === 11155111 ? "Ethereum Sepolia" : "Local test chain",
        details: [`Policy revision: ${options.typedData.message.policyRevision}`, `Approval nonce: ${options.typedData.message.nonce}`,
          `Policy hash: ${options.typedData.message.policyHash}`, "This is a single-use approval, not an unlimited token allowance."],
        transaction: { chainId: options.typedData.domain.chainId, from: options.owner, to: options.typedData.message.target, value: "0", data: "0x" } }); return;
    }
    if (request.method !== "POST" || request.headers.origin !== base) { send(403, {}); return; }
    if (request.url === `${path}/cancel`) { send(200, { cancelled: true }); cancel(); return; }
    if (request.url !== `${path}/complete` || !request.headers["content-type"]?.startsWith("application/json") || settled || verifying) { send(409, {}); return; }
    try {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 8192) { send(413, {}); return; } }
      const { signature } = JSON.parse(body);
      if (typeof signature !== "string" || !/^0x(?:[0-9a-fA-F]{2}){1,2048}$/.test(signature)) { send(400, { error: "Invalid signature" }); return; }
      verifying = true;
      if (Number(options.typedData.message.deadline) <= Math.floor(Date.now() / 1000) || !await options.verify(signature as Hex)) {
        send(400, { error: "Owner signature is invalid or expired" }); return;
      }
      if (settled) { send(409, { error: "Approval cancelled" }); return; }
      settled = true;
      response.once("finish", () => succeed(signature as Hex));
      response.once("close", () => succeed(signature as Hex));
      send(200, { approved: true });
    } catch { send(400, { error: "Approval verification failed" }); }
    finally { verifying = false; }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start local approval server");
  base = `http://127.0.0.1:${address.port}`;
  const timer = setTimeout(cancel, 300_000);
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    if (options.signal?.aborted) cancel();
    else await (options.openBrowser ?? openDefaultBrowser)(`${base}${path}`);
    return await outcome;
  } finally {
    clearTimeout(timer); options.signal?.removeEventListener("abort", cancel); lifecycle.dispose();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
}
