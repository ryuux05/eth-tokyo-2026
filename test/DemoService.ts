import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import hre from "hardhat";
import { toBytes, toHex, type Address, type Hex } from "viem";
import { createAgentSdk } from "../sdk/agent.js";
import { startDemoService } from "../demo-service/server.js";

describe("Service A operator page backend", () => {
  it("uses the service SDK and applies permission changes to an existing session", async () => {
    const { viem } = await hre.network.create();
    const [owner] = await viem.getWalletClients();
    const client = await viem.getPublicClient();
    const entryPoint = await viem.deployContract("MockAgentEntryPoint");
    const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
    const implementation = await factory.read.implementation() as Address;
    const secret = p256.utils.randomPrivateKey();
    const publicKey = p256.getPublicKey(secret, false);
    const salt = `0x${"92".repeat(32)}` as Hex;
    const agentId = await factory.read.predictAgent([owner.account.address, salt]) as Address;
    const transaction = await factory.write.createAgentP256([toHex(publicKey.slice(1, 33)), toHex(publicKey.slice(33, 65)), salt]);
    await client.waitForTransactionReceipt({ hash: transaction });
    const signer = createAgentSdk({ agentId, chainId: await client.getChainId(),
      signDigest: async digest => `0x${p256.sign(toBytes(digest), secret, { prehash: false }).toCompactHex()}` as Hex });
    const running = await startDemoService({ client, chainId: await client.getChainId(), implementation,
      audience: "https://service-a.example", operatorToken: "local-test-operator", port: 0 });
    const post = async (path: string, body: unknown, admin = false) => fetch(`${running.baseUrl}${path}`, {
      method: "POST", headers: { "Content-Type": "application/json", ...(admin ? { "X-Operator-Token": running.operatorToken } : {}) }, body: JSON.stringify(body),
    });
    try {
      assert.equal((await fetch(`${running.baseUrl}/health`)).status, 200);
      const page = await fetch(running.baseUrl);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /Agent access desk/);
      assert.equal((await fetch(`${running.baseUrl}/admin/state`)).status, 401);
      assert.equal((await post("/admin/enroll", { agentId }, true)).status, 200);
      const challengeResponse = await post("/agent/challenge", { agentId });
      assert.equal(challengeResponse.status, 200);
      const challenge = await challengeResponse.json();
      const proof = await signer.answerChallenge(challenge, "https://service-a.example");
      const sessionResponse = await post("/agent/session", proof);
      assert.equal(sessionResponse.status, 200);
      const token = sessionResponse.headers.get("Agent-Session");
      assert.ok(token);
      const resource = (name: "report" | "compute") => fetch(`${running.baseUrl}/private/${name}`, { headers: { "Agent-Session": token } });
      assert.equal((await resource("report")).status, 403);
      assert.equal((await resource("compute")).status, 403);
      assert.equal((await post("/admin/permission", { agentId, resource: "report", allowed: true }, true)).status, 200);
      assert.equal((await resource("report")).status, 200, "same session becomes authorized after grant");
      assert.equal((await resource("compute")).status, 403, "grant stays resource scoped");
      assert.equal((await post("/admin/permission", { agentId, resource: "report", allowed: false }, true)).status, 200);
      assert.equal((await resource("report")).status, 403, "same session immediately loses access after revoke");
      assert.equal((await post("/admin/permission", { agentId, resource: "compute", allowed: true }, true)).status, 200);
      assert.equal((await resource("compute")).status, 200);
      assert.equal((await post("/agent/session", proof)).status, 401, "challenge cannot be replayed");
      const state = await fetch(`${running.baseUrl}/admin/state`, { headers: { "X-Operator-Token": running.operatorToken } });
      assert.equal(state.status, 200);
      const data = await state.json();
      assert.equal(data.enrollments[0].permissions.report, false);
      assert.equal(data.enrollments[0].permissions.compute, true);
      assert.ok(data.events.some((event: { kind: string }) => event.kind === "DENIED"));
    } finally { await running.close(); }
  });
});
