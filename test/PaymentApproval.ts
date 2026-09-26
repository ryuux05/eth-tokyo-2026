import assert from "node:assert/strict";
import { test } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeFunctionData, erc20Abi, keccak256, verifyTypedData, type Hex } from "viem";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { approvePayment } from "../mcp/payment-approval.js";
import { withPaymentJournal } from "../mcp/payment-journal.js";
import { ownerActionTypedData } from "../sdk/policy.js";
import { SEPOLIA_USDC } from "../sdk/payments.js";

test("payment approval binds the owner and exact intent; cancellation closes the loopback server", async () => {
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const intent = { agentId: stranger.address, recipient: owner.address, amount: "20" };
  const typedData = ownerActionTypedData({ agent: intent.agentId, chainId: 11155111, target: SEPOLIA_USDC, value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [intent.recipient, 20_000_000n] }),
    policyHash: keccak256("0x"), policyRevision: 1n, nonce: 3n, deadline: BigInt(Math.floor(Date.now() / 1000) + 300) });
  const verify = (signature: Hex) => verifyTypedData({ address: owner.address, ...typedData, signature });
  const signature = await owner.signTypedData(typedData);
  const result = await approvePayment({ owner: owner.address, intent, typedData, verify, openBrowser: async url => {
    const base = new URL(url).origin;
    const context = await (await fetch(`${url}/context`)).json();
    assert.equal(context.amount, "20"); assert.equal(context.recipient, intent.recipient);
    const post = (body: object, origin = base) => fetch(`${url}/complete`, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal((await post({ signature }, "https://evil.example")).status, 403);
    assert.equal((await post({ signature: await stranger.signTypedData(typedData) })).status, 400);
    assert.equal((await post({ signature: await owner.signTypedData({ ...typedData, message: { ...typedData.message, nonce: 4n } }) })).status, 400);
    assert.equal((await post({ signature })).status, 200);
  } });
  assert.equal(result, signature);
  let opened = "";
  await assert.rejects(approvePayment({ owner: owner.address, intent, typedData, verify, openBrowser: async url => {
    opened = url;
    assert.equal((await fetch(`${url}/cancel`, { method: "POST", headers: { origin: new URL(url).origin } })).status, 200);
  } }), /PAYMENT_CANCELLED/);
  await assert.rejects(fetch(`${opened}/context`));
});

test("payment journal is durable, serializes processes and treats prototype names as plain IDs", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "agentic-journal-test-"));
  const path = join(temporary, "config.json");
  try {
    await withPaymentJournal(path, async journal => {
      assert.equal(await journal.get("constructor"), undefined);
      await assert.rejects(withPaymentJournal(path, async () => {}), /PAYMENT_BUSY/);
      await journal.put({ requestId: "__proto__", agentId: SEPOLIA_USDC, recipient: SEPOLIA_USDC, amount: "1", intentHash: keccak256("0x"), status: "FAILED" });
    });
    await withPaymentJournal(path, async journal => assert.equal((await journal.get("__proto__"))?.status, "FAILED"));
    assert.match(await readFile(`${path}.payments.json`, "utf8"), /__proto__/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
