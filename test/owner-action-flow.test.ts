import assert from "node:assert/strict";
import { test } from "node:test";
import { runOwnerActionFlow } from "../mcp/owner-action-flow.js";

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
  assert.match(await page.text(), /Owner wallet action/);
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
