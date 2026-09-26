import assert from "node:assert/strict";
import { test } from "node:test";
import { runCreationFlow } from "../mcp/creation-flow.js";
import { runOwnerActionFlow } from "../mcp/owner-action-flow.js";
import { FlowCancelledError, FlowInterruptedError } from "../mcp/flow-cancel.js";

const owner = "0x1111111111111111111111111111111111111111";
const factory = "0x2222222222222222222222222222222222222222";
const agent = "0x3333333333333333333333333333333333333333";
const hash = `0x${"4".repeat(64)}` as const;
const transaction = { chainId: 31337, from: owner, to: factory, value: "0", data: "0x1234" } as const;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function start(kind: "creation" | "owner", confirm = async () => {}, signal?: AbortSignal) {
  let opened!: (url: string) => void;
  const urlReady = new Promise<string>(resolve => { opened = resolve; });
  const options = { rpcUrl: "http://127.0.0.1:8545", timeoutMs: 3000, disconnectGraceMs: 60, signal,
    openBrowser: async (url: string) => { opened(url); } };
  const flow = kind === "creation"
    ? runCreationFlow({ ...options, chainId: 31337, factory, qx: `0x${"5".repeat(64)}`, qy: `0x${"6".repeat(64)}`,
      prepare: async () => ({ predictedAgent: agent, transaction }), confirm: async () => { await confirm(); return agent; } })
    : runOwnerActionFlow({ ...options,
      intent: { action: "revoke", agentId: agent, summary: "Revoke", details: [], transaction },
      confirm: async () => { await confirm(); return "confirmed"; } });
  // Capture failure immediately, including while the opener is still resolving.
  const result = flow.then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
  const url = await urlReady;
  const post = (path: string, body = {}, headers = {}) => fetch(`${url}/${path}`, { method: "POST",
    headers: { Origin: new URL(url).origin, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const context = async () => (await fetch(`${url}/context`)).json();
  if (kind === "creation") assert.equal((await post("prepare", { owner })).status, 200);
  return { url, result, post, context };
}

async function attach(url: string) {
  const abort = new AbortController();
  const response = await fetch(`${url}/events`, { signal: abort.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
  const reader = response.body!.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /connected/);
  return () => { abort.abort(); void reader.cancel().catch(() => {}); };
}

for (const kind of ["creation", "owner"] as const) {
  test(`${kind}: cancelling the MCP request closes its unused approval server`, async () => {
    const abort = new AbortController();
    const flow = await start(kind, async () => {}, abort.signal);
    abort.abort();
    assert((await flow.result).error instanceof FlowCancelledError);
    await assert.rejects(fetch(`${flow.url}/context`));
  });

  test(`${kind}: lost page connection releases the flow and a new approval can start`, async () => {
    const first = await start(kind);
    const close = await attach(first.url);
    close(); // No unload beacon: covers a killed tab/browser as well.
    assert((await first.result).error instanceof FlowCancelledError);
    await assert.rejects(fetch(`${first.url}/context`));
    const next = await start(kind);
    assert.notEqual(next.url, first.url);
    assert.equal((await next.post("complete", { hash })).status, 200);
    assert.equal((await next.result).error, undefined);
  });

  test(`${kind}: refresh reconnects, background connection stays alive, foreign mutations fail`, async () => {
    const flow = await start(kind);
    const close = await attach(flow.url);
    close();
    const closeReload = await attach(flow.url);
    await pause(120); // Longer than grace: an open background page must stay alive.
    const state = await flow.context();
    if (kind === "creation") assert.equal(state.intent.predictedAgent, agent);
    assert.equal((await fetch(`${flow.url}/events`, { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await flow.post("wallet", {}, { Origin: "https://evil.example", "X-Agentic-Wallet-State": "pending" })).status, 403);
    assert.equal((await flow.context()).walletPending, false);
    closeReload();
    assert((await flow.result).error instanceof FlowCancelledError);
  });

  test(`${kind}: closing during wallet approval reports uncertainty, rejection permits safe retry`, async () => {
    const flow = await start(kind);
    const close = await attach(flow.url);
    assert.equal((await flow.post("wallet", {}, { "X-Agentic-Wallet-State": "pending" })).status, 204);
    assert.equal((await flow.context()).walletPending, true);
    close();
    const { error } = await flow.result;
    assert(error instanceof FlowInterruptedError);
    assert.match(error.message, /Reject any outstanding wallet prompt/);
    const next = await start(kind);
    const closeNext = await attach(next.url);
    await next.post("wallet", {}, { "X-Agentic-Wallet-State": "pending" });
    await next.post("wallet", {}, { "X-Agentic-Wallet-State": "rejected" });
    closeNext();
    assert((await next.result).error instanceof FlowCancelledError);
  });

  for (const succeeds of [true, false]) {
    test(`${kind}: submitted transaction ${succeeds ? "confirms" : "reports its hash"} after all browser connections close`, async () => {
      let release!: () => void;
      let started!: () => void;
      const confirmation = new Promise<void>(resolve => { release = resolve; });
      const confirming = new Promise<void>(resolve => { started = resolve; });
      const flow = await start(kind, async () => { started(); await confirmation; if (!succeeds) throw new Error("RPC unavailable"); });
      const close = await attach(flow.url);
      const abort = new AbortController();
      const completion = fetch(`${flow.url}/complete`, { signal: abort.signal, method: "POST",
        headers: { Origin: new URL(flow.url).origin, "Content-Type": "application/json" }, body: JSON.stringify({ hash }) }).catch(() => {});
      await confirming;
      assert.equal((await flow.context()).submittedHash, hash);
      abort.abort(); close();
      await pause(100);
      release();
      const result = await flow.result;
      await completion;
      if (succeeds) assert.equal(result.error, undefined);
      else {
        assert(result.error instanceof FlowInterruptedError);
        assert.equal(result.error.transactionHash, hash);
      }
    });
  }
}
