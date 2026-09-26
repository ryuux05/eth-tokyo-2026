import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import hre from "hardhat";
import { toBytes, toHex, type Address, type Hex } from "viem";
import { createAgentSdk } from "../sdk/agent.js";
import { startDemoServiceB } from "../demo-service-b/server.js";

describe("Service B owner registration", () => {
  it("requires a wallet signature and agent proof before granting the registered owner a report", async () => {
    const { viem } = await hre.network.create();
    const [owner, stranger] = await viem.getWalletClients();
    const client = await viem.getPublicClient();
    const entryPoint = await viem.deployContract("MockAgentEntryPoint");
    const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
    const implementation = await factory.read.implementation() as Address;
    const secret = p256.utils.randomPrivateKey();
    const publicKey = p256.getPublicKey(secret, false);
    const salt = `0x${"a2".repeat(32)}` as Hex;
    const agentId = await factory.read.predictAgent([owner.account.address, salt]) as Address;
    const tx = await factory.write.createAgentP256([toHex(publicKey.slice(1, 33)), toHex(publicKey.slice(33, 65)), salt]);
    await client.waitForTransactionReceipt({ hash: tx });
    const agent = createAgentSdk({ agentId, chainId: await client.getChainId(),
      signDigest: async digest => `0x${p256.sign(toBytes(digest), secret, { prehash: false }).toCompactHex()}` as Hex });
    const running = await startDemoServiceB({ client, chainId: await client.getChainId(), implementation,
      audience: "https://service-b.example", port: 0 });
    const post = (path: string, body: unknown) => fetch(`${running.baseUrl}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const prove = async () => {
      const challengeResponse = await post("/agent/challenge", { agentId });
      assert.equal(challengeResponse.status, 200);
      const challenge = await challengeResponse.json();
      return agent.answerChallenge(challenge, "https://service-b.example");
    };
    try {
      assert.equal((await fetch(`${running.baseUrl}/health`)).status, 200);
      assert.match(await (await fetch(running.baseUrl)).text(), /Register yourself/);
      assert.equal((await fetch(`${running.baseUrl}/private/report`)).status, 401, "no identity means no session");

      const before = await post("/agent/lookup", { agentId });
      assert.equal(before.status, 200);
      assert.equal((await before.json()).ownerRegistered, false);
      assert.equal((await post("/agent/session", await prove())).status, 401, "agent alone cannot enter an unregistered owner's service account");

      const walletChallengeResponse = await post("/owner/challenge", { owner: owner.account.address });
      assert.equal(walletChallengeResponse.status, 200);
      const walletChallenge = await walletChallengeResponse.json();
      const wrongSignature = await stranger.signMessage({ account: stranger.account, message: walletChallenge.message });
      assert.equal((await post("/owner/register", { owner: owner.account.address, nonce: walletChallenge.nonce, signature: wrongSignature })).status, 401);
      assert.equal((await post("/owner/register", { owner: owner.account.address, nonce: walletChallenge.nonce, signature: wrongSignature })).status, 401,
        "a consumed wallet nonce cannot be replayed");

      const retryResponse = await post("/owner/challenge", { owner: owner.account.address });
      const retry = await retryResponse.json();
      const signature = await owner.signMessage({ account: owner.account, message: retry.message });
      const registration = await post("/owner/register", { owner: owner.account.address, nonce: retry.nonce, signature });
      assert.equal(registration.status, 200);
      assert.equal((await registration.json()).report, true);
      assert.equal((await post("/owner/register", { owner: owner.account.address, nonce: retry.nonce, signature })).status, 401);

      const after = await post("/agent/lookup", { agentId });
      assert.equal((await after.json()).ownerRegistered, true);
      const sessionResponse = await post("/agent/session", await prove());
      assert.equal(sessionResponse.status, 200);
      const session = sessionResponse.headers.get("Agent-Session");
      assert.ok(session);
      const report = await fetch(`${running.baseUrl}/private/report`, { headers: { "Agent-Session": session } });
      assert.equal(report.status, 200);
      assert.equal((await report.json()).owner.toLowerCase(), owner.account.address.toLowerCase());
      const activity = await (await fetch(`${running.baseUrl}/activity`)).json();
      assert.ok(activity.events.some((event: { kind: string }) => event.kind === "ALLOWED"));
      assert.ok(activity.events.some((event: { kind: string }) => event.kind === "WALLET_REGISTERED"));
    } finally { await running.close(); }
  });
});
