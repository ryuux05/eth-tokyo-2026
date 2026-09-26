import assert from "node:assert/strict";
import { test } from "node:test";
import type { Address } from "viem";
import { runCreationFlow } from "../mcp/creation-flow.js";

test("local creation page requires its one-time URL and same-origin owner approval", async () => {
  const owner = "0x1111111111111111111111111111111111111111";
  const factory = "0x2222222222222222222222222222222222222222";
  const agent = "0x3333333333333333333333333333333333333333";
  const hash = `0x${"4".repeat(64)}` as const;
  let opened = "";
  let prepared = 0;
  let confirmed = 0;
  const flow = runCreationFlow({ chainId: 31337, factory, rpcUrl: "http://127.0.0.1:8545",
    qx: `0x${"5".repeat(64)}`, qy: `0x${"6".repeat(64)}`, timeoutMs: 5000,
    openBrowser: async url => { opened = url; },
    prepare: async selectedOwner => {
      assert.equal(selectedOwner, owner);
      prepared++;
      return { predictedAgent: agent, transaction: { chainId: 31337, from: owner, to: factory, value: "0", data: "0x1234" } };
    },
    confirm: async (submittedHash, intent) => {
      assert.equal(submittedHash, hash);
      assert.equal(intent.predictedAgent, agent);
      confirmed++;
      return agent;
    },
  });
  for (let i = 0; !opened && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened);
  const url = new URL(opened);
  assert.equal(url.hostname, "127.0.0.1");
  const page = await fetch(opened);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Create agent identity/);
  const outsider = await fetch(`${url.origin}/flow/not-the-token/context`);
  assert.equal(outsider.status, 404);
  const rejected = await fetch(`${opened}/prepare`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://attacker.example" }, body: JSON.stringify({ owner }) });
  assert.equal(rejected.status, 403);
  const preparedResponse = await fetch(`${opened}/prepare`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin }, body: JSON.stringify({ owner }) });
  assert.equal(preparedResponse.status, 200);
  assert.equal((await preparedResponse.json()).predictedAgent, agent);
  const completed = await fetch(`${opened}/complete`, { method: "POST", headers: { "Content-Type": "application/json", Origin: url.origin }, body: JSON.stringify({ hash }) });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).agentId, agent);
  assert.equal(await flow, agent);
  assert.equal(prepared, 1);
  assert.equal(confirmed, 1);
});

test("creation approval can be cancelled before a transaction, but not after submission", async () => {
  const owner = "0x1111111111111111111111111111111111111111" as Address;
  const factory = "0x2222222222222222222222222222222222222222" as Address;
  const agent = "0x3333333333333333333333333333333333333333" as Address;
  const hash = `0x${"4".repeat(64)}` as const;
  const options = {
    chainId: 31337, factory, rpcUrl: "http://127.0.0.1:8545",
    qx: `0x${"5".repeat(64)}` as const, qy: `0x${"6".repeat(64)}` as const, timeoutMs: 5000,
    prepare: async () => ({ predictedAgent: agent, transaction: { chainId: 31337, from: owner, to: factory, value: "0", data: "0x1234" as const } }),
  };
  let opened = "";
  const cancelledFlow = runCreationFlow({ ...options, openBrowser: async url => { opened = url; }, confirm: async () => agent });
  const cancelledResult = assert.rejects(cancelledFlow, { name: "FlowCancelledError" });
  for (let i = 0; !opened && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened);
  const origin = new URL(opened).origin;
  const foreign = await fetch(`${opened}/cancel`, { method: "POST", headers: { Origin: "https://attacker.example" } });
  assert.equal(foreign.status, 403);
  const cancelled = await fetch(`${opened}/cancel`, { method: "POST", headers: { Origin: origin } });
  assert.equal(cancelled.status, 200);
  await cancelledResult;

  let releaseConfirmation: (() => void) | undefined;
  const confirmation = new Promise<void>(resolve => { releaseConfirmation = resolve; });
  opened = "";
  const submittedFlow = runCreationFlow({ ...options, openBrowser: async url => { opened = url; }, confirm: async () => { await confirmation; return agent; } });
  for (let i = 0; !opened && i < 50; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(opened);
  const submittedOrigin = new URL(opened).origin;
  const prepared = await fetch(`${opened}/prepare`, { method: "POST", headers: { Origin: submittedOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ owner }) });
  assert.equal(prepared.status, 200);
  const completing = fetch(`${opened}/complete`, { method: "POST", headers: { Origin: submittedOrigin, "Content-Type": "application/json" }, body: JSON.stringify({ hash }) });
  for (let i = 0; i < 50; i++) {
    const context = await (await fetch(`${opened}/context`)).json();
    if (context.submittedHash === hash) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const refused = await fetch(`${opened}/cancel`, { method: "POST", headers: { Origin: submittedOrigin } });
  assert.equal(refused.status, 409);
  releaseConfirmation?.();
  assert.equal((await completing).status, 200);
  assert.equal(await submittedFlow, agent);
});
