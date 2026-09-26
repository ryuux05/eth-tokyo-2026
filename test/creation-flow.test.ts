import assert from "node:assert/strict";
import { test } from "node:test";
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
