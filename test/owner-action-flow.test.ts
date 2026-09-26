import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { runOwnerActionFlow, type OwnerActionIntent } from "../mcp/owner-action-flow.js";

test("owner action page binds to loopback, rejects cross-origin completion, and confirms once", async () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const agent = "0x2222222222222222222222222222222222222222";
  const hash = `0x${"3".repeat(64)}` as const;
  let opened = "";
  let confirmations = 0;
  const flow = runOwnerActionFlow({
    intent: { action: "revoke", agentId: agent, summary: "Revoke authentication", details: ["No new proofs"],
      transaction: { chainId: 31337, from: owner, to: agent, value: "0", data: "0x1234" } },
    rpcUrl: "http://127.0.0.1:8545", timeoutMs: 5000,
    openBrowser: async url => { opened = url; },
    confirm: async submitted => { assert.equal(submitted, hash); confirmations++; return { authenticationRevoked: true }; },
  });
  for (let i = 0; !opened && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened);
  const url = new URL(opened);
  assert.equal(url.hostname, "127.0.0.1");
  const page = await fetch(opened);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Owner approval/);
  const context = await fetch(`${opened}/context`);
  assert.equal(context.status, 200);
  assert.equal((await context.json()).transaction.from, owner);
  const outsider = await fetch(`${url.origin}/flow/not-the-token/context`);
  assert.equal(outsider.status, 404);
  const rejected = await fetch(`${opened}/complete`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify({ hash }) });
  assert.equal(rejected.status, 403);
  const invalid = await fetch(`${opened}/complete`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin }, body: JSON.stringify({ hash: "bad" }) });
  assert.equal(invalid.status, 400);
  const completed = await fetch(`${opened}/complete`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin }, body: JSON.stringify({ hash }) });
  assert.equal(completed.status, 200);
  assert.deepEqual(await flow, { hash, state: { authenticationRevoked: true } });
  assert.equal(confirmations, 1);
});

test("owner approval can be cancelled before a transaction, but not after submission", async () => {
  const owner = "0x1111111111111111111111111111111111111111" as Address;
  const agent = "0x2222222222222222222222222222222222222222" as Address;
  const hash = `0x${"3".repeat(64)}` as const;
  const intent: OwnerActionIntent = { action: "revoke", agentId: agent, summary: "Revoke authentication", details: ["No new proofs"],
    transaction: { chainId: 31337, from: owner, to: agent, value: "0", data: "0x1234" as const } };
  let opened = "";
  const cancelledFlow = runOwnerActionFlow({ intent, rpcUrl: "http://127.0.0.1:8545", timeoutMs: 5000,
    openBrowser: async url => { opened = url; }, confirm: async () => ({ authenticationRevoked: true }) });
  const cancelledResult = assert.rejects(cancelledFlow, { name: "FlowCancelledError" });
  for (let i = 0; !opened && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened);
  const origin = new URL(opened).origin;
  assert.equal((await fetch(`${opened}/cancel`, { method: "POST", headers: { Origin: "https://attacker.example" } })).status, 403);
  assert.equal((await fetch(`${opened}/cancel`, { method: "POST", headers: { Origin: origin } })).status, 200);
  await cancelledResult;

  let releaseConfirmation: (() => void) | undefined;
  const confirmation = new Promise<void>(resolve => { releaseConfirmation = resolve; });
  opened = "";
  const submittedFlow = runOwnerActionFlow({ intent, rpcUrl: "http://127.0.0.1:8545", timeoutMs: 5000,
    openBrowser: async url => { opened = url; }, confirm: async () => { await confirmation; return { authenticationRevoked: true }; } });
  for (let i = 0; !opened && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened);
  const submittedOrigin = new URL(opened).origin;
  const completing = fetch(`${opened}/complete`, { method: "POST", headers: { Origin: submittedOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ hash }) });
  for (let i = 0; i < 50; i++) {
    const context = await (await fetch(`${opened}/context`)).json();
    if (context.submittedHash === hash) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal((await fetch(`${opened}/cancel`, { method: "POST", headers: { Origin: submittedOrigin } })).status, 409);
  releaseConfirmation?.();
  assert.equal((await completing).status, 200);
  assert.deepEqual(await submittedFlow, { hash, state: { authenticationRevoked: true } });
});
