import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import hre from "hardhat";
import { toBytes, toHex, type Address, type Hex } from "viem";
import { createAgentSdk, sessionProofHeaders } from "../sdk/agent.js";
import { startDemoService } from "../demo-service/server.js";

describe("Service A operator page backend", () => {
  it("uses the service SDK and applies permission changes to an existing session", async () => {
    const { viem } = await hre.network.create();
    const [owner, stranger] = await viem.getWalletClients();
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
      const offered = await fetch(`${running.baseUrl}/private/report`);
      assert.equal(offered.status, 401);
      assert.match(offered.headers.get("www-authenticate") ?? "", /^AgenticWorld /);
      assert.deepEqual((await offered.json()).authentication, { scheme: "AgenticWorld", audience: "https://service-a.example",
        transport: "resource" });
      const ordinary = await fetch(`${running.baseUrl}/admin/state`);
      assert.equal(ordinary.status, 401);
      assert.equal(ordinary.headers.get("www-authenticate"), null, "operator auth is not an Agentic World offer");
      assert.equal((await post("/admin/enroll", { agentId }, true)).status, 404, "operator cannot silently enroll a user's agent");
      const firstEnrollment = await (await post("/user/enrollment-challenge", { agentId })).json();
      const wrongSignature = await stranger.signMessage({ account: stranger.account, message: firstEnrollment.message });
      assert.equal((await post("/user/enroll", { agentId, nonce: firstEnrollment.nonce, signature: wrongSignature })).status, 401);
      const enrollment = await (await post("/user/enrollment-challenge", { agentId })).json();
      const signature = await owner.signMessage({ account: owner.account, message: enrollment.message });
      assert.equal((await post("/user/enroll", { agentId, nonce: enrollment.nonce, signature })).status, 200);
      assert.equal((await post("/user/enroll", { agentId, nonce: enrollment.nonce, signature })).status, 401, "owner proof is single-use");
      assert.equal((await post("/agent/challenge", { agentId })).status, 404, "no separate auth routes");
      assert.equal((await post("/agent/session", {})).status, 404);
      const getChallenge = async () => {
        const response = await fetch(`${running.baseUrl}/private/report`, { headers: { "Agent-ID": agentId } });
        assert.equal(response.status, 401);
        return (await response.json()).authentication.challenge;
      };
      const challenge = await getChallenge();
      const proof = await signer.answerChallenge(challenge, "https://service-a.example");
      const sendProof = (signed: typeof proof) => fetch(`${running.baseUrl}/private/report`, { headers: sessionProofHeaders(signed) });
      const beforeGrant = await sendProof(proof);
      assert.equal(beforeGrant.status, 403, "resource permission is checked before creating a session");
      assert.equal(beforeGrant.headers.get("Agent-Session"), null);
      assert.equal((await post("/admin/permission", { agentId, resource: "report", allowed: true }, true)).status, 200);
      const admittedProof = await signer.answerChallenge(await getChallenge(), "https://service-a.example");
      const sessionResponse = await sendProof(admittedProof);
      assert.equal(sessionResponse.status, 200);
      assert.equal((await sessionResponse.json()).resource, "report");
      const token = sessionResponse.headers.get("Agent-Session");
      assert.ok(token);
      const resource = (name: "report" | "compute") => fetch(`${running.baseUrl}/private/${name}`, { headers: { "Agent-Session": token } });
      await post("/admin/permission", { agentId, resource: "report", allowed: false }, true);
      const denied = await resource("report");
      assert.equal(denied.status, 403);
      assert.equal(denied.headers.get("www-authenticate"), null, "authorization denial must not re-trigger agent authentication");
      assert.equal((await resource("compute")).status, 403);
      assert.equal((await post("/admin/permission", { agentId, resource: "report", allowed: true }, true)).status, 200);
      const allowed = await resource("report");
      assert.equal(allowed.status, 200, "same session becomes authorized after grant");
      assert.equal(allowed.headers.get("www-authenticate"), null, "available resource has no authentication offer");
      assert.equal((await resource("compute")).status, 403, "grant stays resource scoped");
      assert.equal((await post("/admin/permission", { agentId, resource: "report", allowed: false }, true)).status, 200);
      assert.equal((await resource("report")).status, 403, "same session immediately loses access after revoke");
      assert.equal((await post("/admin/permission", { agentId, resource: "compute", allowed: true }, true)).status, 200);
      assert.equal((await resource("compute")).status, 200);
      assert.equal((await sendProof(admittedProof)).status, 401, "challenge cannot be replayed");
      const state = await fetch(`${running.baseUrl}/admin/state`, { headers: { "X-Operator-Token": running.operatorToken } });
      assert.equal(state.status, 200);
      const data = await state.json();
      assert.equal(data.enrollments[0].permissions.report, false);
      assert.equal(data.enrollments[0].permissions.compute, true);
      assert.ok(data.events.some((event: { kind: string }) => event.kind === "DENIED"));
    } finally { await running.close(); }
  });
});
