import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import hre from "hardhat";
import { concatHex, encodeFunctionData, parseAbiItem, parseEther, parseEventLogs, toBytes, toHex, zeroAddress, type Address, type Hex } from "viem";
import { createAgentSdk, sessionProofHeaders } from "../sdk/agent.js";
import { Decision, decodePolicy, encodePolicy, ownerActionTypedData } from "../sdk/policy.js";
import { encodeAgentExecution, type OwnerApproval } from "../sdk/execution.js";
import { parseUsdc, purchaseData, serviceCPolicy } from "../demo-service-c/policy.js";
import { startDemoServiceC } from "../demo-service-c/server.js";
import { redisStores } from "../demo-service-c/stores.js";

const operationEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)");

async function setup() {
  const { viem } = await hre.network.create();
  const [owner, stranger] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  const entryPoint = await viem.deployContract("RealEntryPoint");
  const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
  const token = await viem.deployContract("PolicyDemoUSDC");
  const shop = await viem.deployContract("PolicyDemoService");
  const secret = p256.utils.randomPrivateKey();
  const publicKey = p256.getPublicKey(secret, false);
  const salt = `0x${"c3".repeat(32)}` as Hex;
  const agentId = await factory.read.predictAgent([owner.account.address, salt]) as Address;
  const mined = (hash: Hex) => client.waitForTransactionReceipt({ hash });
  await mined(await factory.write.createAgentP256([toHex(publicKey.slice(1, 33)), toHex(publicKey.slice(33, 65)), salt]));
  const account = await viem.getContractAt("AgentAccount4337", agentId);
  const chainId = await client.getChainId();
  const sign = async (hash: Hex) => `0x${p256.sign(toBytes(hash), secret, { prehash: false }).toCompactHex()}` as Hex;
  const setPolicy = async (policy: Hex) => mined(await account.write.setPolicy([policy]));
  const data = (amount: string) => purchaseData(token.address, parseUsdc(amount));
  const signApproval = async (target: Address, payload: Hex, signer = owner) => {
    const nonce = await account.read.ownerApprovalNonce() as bigint;
    const deadline = (await client.getBlock()).timestamp + 3600n;
    const signature = await signer.signTypedData(ownerActionTypedData({ agent: agentId, chainId,
      target, value: 0n, data: payload, policyHash: await account.read.policyHash() as Hex,
      policyRevision: await account.read.policyRevision() as bigint, nonce, deadline }));
    return { nonce, deadline, signature };
  };
  const execute = async (target: Address, payload: Hex, approval?: OwnerApproval) => {
    const unsigned = { sender: agentId, nonce: await entryPoint.read.getNonce([agentId, 0n]), initCode: "0x" as Hex,
      callData: encodeAgentExecution(target, 0n, payload, approval),
      accountGasLimits: concatHex([toHex(1_000_000n, { size: 16 }), toHex(500_000n, { size: 16 })]),
      preVerificationGas: 100_000n,
      gasFees: concatHex([toHex(1_000_000_000n, { size: 16 }), toHex(2_000_000_000n, { size: 16 })]),
      paymasterAndData: "0x" as Hex, signature: "0x" as Hex };
    const hash = await entryPoint.read.getUserOpHash([unsigned]) as Hex;
    const op = { ...unsigned, signature: await sign(hash) };
    const receipt = await mined(await entryPoint.write.handleOps([[op], owner.account.address]));
    const events = parseEventLogs({ abi: [operationEvent], logs: receipt.logs, eventName: "UserOperationEvent" });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.userOpHash, hash);
    return events[0].args.success; // A successful outer receipt alone does NOT prove UserOperation success.
  };
  return { owner, stranger, client, entryPoint, factory, token, shop, agentId, account, chainId, sign, mined, setPolicy, data, signApproval, execute };
}

describe("Service C policy demonstration", () => {
  it("keeps six-decimal amounts exact and encodes ordered <=5 / >5 rules", () => {
    for (const amount of ["-1", "0", "0.000000", "1e6", "5.0000001", "5.", " 5", "NaN", "01", "0x5"])
      assert.throws(() => parseUsdc(amount));
    assert.equal(parseUsdc("5.000001"), 5_000_001n);
    assert.equal(parseUsdc("5"), 5_000_000n);
    const rules = decodePolicy(serviceCPolicy("0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"));
    assert.equal(rules[0].maxAmount, 5_000_000n);
    assert.equal(rules[0].decision, Decision.ALLOW);
    assert.equal(rules[1].decision, Decision.REQUIRE_OWNER_SIGNATURE);
    assert.throws(() => serviceCPolicy(rules[0].target, zeroAddress));
  });

  it("enforces the 5-USDC boundary with P-256 through the real EntryPoint, not just evaluateAction", async () => {
    const c = await setup();
    await c.mined(await c.entryPoint.write.depositTo([c.agentId], { value: parseEther("0.1") }));
    await c.mined(await c.token.write.mint([c.agentId, 100_000_000n]));
    const approve = encodeFunctionData({ abi: c.token.abi, functionName: "approve", args: [c.shop.address, 100_000_000n] });
    // Local fixture only: explicit owner approval of a bounded allowance to this exact shop.
    // The browser preview never installs this rule or grants any allowance.
    const purchaseRules = decodePolicy(serviceCPolicy(c.shop.address, c.token.address));
    await c.setPolicy(encodePolicy([...purchaseRules, { target: c.token.address, selector: approve.slice(0, 10) as Hex,
      token: zeroAddress, maxAmount: 0n, maxValue: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE }]));
    assert.equal(await c.execute(c.token.address, approve), false);
    assert.equal(await c.execute(c.token.address, approve, await c.signApproval(c.token.address, approve)), true);
    await c.setPolicy(serviceCPolicy(c.shop.address, c.token.address));
    assert.equal(await c.execute(c.shop.address, c.data("5")), true, "exactly 5 needs no owner signature");
    assert.equal(await c.token.read.balanceOf([c.shop.address]), 5_000_000n);
    assert.equal(await c.execute(c.shop.address, c.data("5.000001")), false, "one base unit above the limit must fail");
    assert.equal(await c.execute(c.shop.address, c.data("20")), false, "above-limit execution without approval fails");
    assert.equal(await c.token.read.balanceOf([c.shop.address]), 5_000_000n, "failed operations move no tokens");
    const wrong = await c.signApproval(c.shop.address, c.data("20"), c.stranger);
    assert.equal(await c.execute(c.shop.address, c.data("20"), wrong), false);
    const approval = await c.signApproval(c.shop.address, c.data("20"));
    assert.equal(await c.execute(c.shop.address, c.data("21"), approval), false, "approval is bound to amount");
    assert.equal(await c.execute(c.shop.address, c.data("20"), approval), true);
    assert.equal(await c.token.read.balanceOf([c.shop.address]), 25_000_000n);
    assert.equal(await c.execute(c.shop.address, c.data("20"), approval), false, "owner approval cannot be replayed under a fresh UserOp nonce");
    const old = await c.signApproval(c.shop.address, c.data("20"));
    await c.setPolicy(serviceCPolicy(c.shop.address, c.token.address, 3_000_000n));
    assert.equal(await c.account.read.evaluateAction([c.shop.address, 0n, c.data("5")]), Decision.REQUIRE_OWNER_SIGNATURE);
    assert.equal(await c.execute(c.shop.address, c.data("5")), false, "new policy takes effect on the next execution");
    assert.equal(await c.execute(c.shop.address, c.data("20"), old), false, "updating policy invalidates old approval");
    await c.setPolicy(encodePolicy([]));
    assert.equal(await c.execute(c.shop.address, c.data("20"), await c.signApproval(c.shop.address, c.data("20"))), false, "owner approval cannot bypass DENY");
    assert.equal(await c.token.read.balanceOf([c.shop.address]), 25_000_000n);
  });

  it("serves live previews and same-resource SDK authentication, observing updates within the same session", async () => {
    const c = await setup();
    const shared = new Map<string, string>();
    const activity: string[] = [];
    const command = async (args: (string | number)[]): Promise<unknown> => {
      const key = String(args[1]);
      if (args[0] === "SET") { shared.set(key, String(args[2])); return "OK"; }
      if (args[0] === "EVAL") { activity.unshift(String(args[4])); return 1; }
      if (args[0] === "LRANGE") return activity.slice(0, 40);
      const value = shared.get(key) ?? null;
      if (args[0] === "GETDEL") shared.delete(key);
      return value;
    };
    const running = await startDemoServiceC({ client: c.client, chainId: c.chainId,
      implementation: await c.factory.read.implementation() as Address, token: c.token.address, port: 0,
      stores: redisStores(command, "test-service-c") });
    const otherWorker = await startDemoServiceC({ client: c.client, chainId: c.chainId,
      implementation: await c.factory.read.implementation() as Address, token: c.token.address, port: 0,
      stores: redisStores(command, "test-service-c") });
    const sdk = createAgentSdk({ agentId: c.agentId, chainId: c.chainId, signDigest: c.sign });
    const route = `/private/quote?target=${c.shop.address}&amount=5`;
    const preview = (amount: string, target = c.shop.address) => fetch(`${running.baseUrl}/policy/preview?agentId=${c.agentId}&target=${target}&amount=${amount}`);
    try {
      assert.equal((await fetch(running.baseUrl)).status, 404, "the test adapter only serves API routes; Next.js serves the page");
      assert.equal((await fetch(`${running.baseUrl}/config`)).status, 200);
      assert.equal((await fetch(`${running.baseUrl}/config`, { headers: { Origin: "https://evil.example" } })).status, 403);
      assert.equal((await fetch(`${running.baseUrl}/policy/preview`, { method: "POST" })).status, 405);
      assert.equal((await preview("5", c.stranger.account.address)).status, 400);
      assert.equal((await preview("5.0000001")).status, 400);
      assert.equal((await (await preview("5")).json()).decision, "DENY");
      const offered = await fetch(`${running.baseUrl}${route}`);
      assert.equal(offered.status, 401);
      assert.match(offered.headers.get("www-authenticate") ?? "", /^AgenticWorld /);
      const post = (path: string, body: unknown) => fetch(`${running.baseUrl}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const before = (await (await fetch(`${running.baseUrl}${route}`, { headers: { "Agent-ID": c.agentId } })).json()).authentication.challenge;
      const rejected = await fetch(`${running.baseUrl}${route}`, { headers: sessionProofHeaders(await sdk.answerChallenge(before, "https://service-c.example")) });
      assert.notEqual(rejected.status, 200, "a verified agent with an unregistered owner has no quote access");
      const ownerChallenge = await (await post("/owner/challenge", { owner: c.owner.account.address })).json();
      const invalidSignature = await c.stranger.signMessage({ message: ownerChallenge.message });
      assert.equal((await post("/owner/register", { owner: c.owner.account.address, nonce: ownerChallenge.nonce, signature: invalidSignature })).status, 401);
      const signature = await c.owner.signMessage({ message: ownerChallenge.message });
      const body = { owner: c.owner.account.address, nonce: ownerChallenge.nonce, signature };
      assert.equal((await fetch(`${running.baseUrl}/owner/register`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: JSON.stringify(body) })).status, 403);
      assert.equal((await post("/owner/register", body)).status, 200);
      assert.equal((await post("/owner/register", body)).status, 401, "registration proof is one-time");
      assert.equal((await (await fetch(`${otherWorker.baseUrl}/owner/status?owner=${c.owner.account.address}`)).json()).registered, true);
      const secondSalt = `0x${"c4".repeat(32)}` as Hex;
      const secondAgent = await c.factory.read.predictAgent([c.owner.account.address, secondSalt]) as Address;
      const [qx, qy] = await c.account.read.authenticatorP256() as readonly [Hex, Hex];
      await c.mined(await c.factory.write.createAgentP256([qx, qy, secondSalt]));
      const secondSdk = createAgentSdk({ agentId: secondAgent, chainId: c.chainId, signDigest: c.sign });
      const secondChallenge = (await (await fetch(`${running.baseUrl}${route}`, { headers: { "Agent-ID": secondAgent } })).json()).authentication.challenge;
      assert.equal((await fetch(`${running.baseUrl}${route}`, { headers: sessionProofHeaders(await secondSdk.answerChallenge(secondChallenge, "https://service-c.example")) })).status, 200,
        "another agent owned by the registered human needs no individual registration");
      const challenge = (await (await fetch(`${running.baseUrl}${route}`, { headers: { "Agent-ID": c.agentId } })).json()).authentication.challenge;
      const proof = await sdk.answerChallenge(challenge, "https://service-c.example");
      const raced = await Promise.all([running, otherWorker].map(worker => fetch(`${worker.baseUrl}${route}`, { headers: sessionProofHeaders(proof) })));
      assert.deepEqual(raced.map(value => value.status).sort(), [200, 401], "only one worker may consume a challenge");
      const response = raced.find(value => value.status === 200)!;
      assert.equal(response.status, 200);
      const session = response.headers.get("Agent-Session"); assert.ok(session);
      assert.equal((await response.json()).decision, "DENY");
      await c.setPolicy(serviceCPolicy(c.shop.address, c.token.address));
      const allowed = await (await fetch(`${running.baseUrl}${route}`, { headers: { "Agent-Session": session } })).json();
      assert.equal(allowed.agentId.toLowerCase(), c.agentId.toLowerCase());
      assert.equal(allowed.decision, "ALLOW");
      assert.equal(allowed.executionSubmitted, false);
      assert.equal(allowed.purchase.product, "Compute credits");
      assert.equal(allowed.purchase.status, "NOT_PAID");
      assert.equal(allowed.purchase.creditsDelivered, false);
      assert.equal(allowed.purchase.action.target.toLowerCase(), c.shop.address.toLowerCase());
      assert.equal(allowed.purchase.action.valueWei, "0");
      assert.equal(allowed.purchase.action.data, c.data("5"));
      assert.equal((await (await preview("5.000001")).json()).decision, "REQUIRE_OWNER_SIGNATURE");
      await c.setPolicy(serviceCPolicy(c.shop.address, c.token.address, 3_000_000n));
      const changed = await (await fetch(`${running.baseUrl}${route}`, { headers: { "Agent-Session": session } })).json();
      assert.equal(changed.decision, "REQUIRE_OWNER_SIGNATURE");
      assert.ok(BigInt(changed.blockNumber) > BigInt(allowed.blockNumber));
      assert.ok(BigInt(changed.policyRevision) > BigInt(allowed.policyRevision));
      await c.mined(await c.account.write.revokeAuthenticator());
      const revoked = await (await preview("2")).json();
      assert.equal(revoked.revoked, true); assert.equal(revoked.decision, "ALLOW", "policy is distinct from authenticator validity");
      assert.equal(await c.token.read.balanceOf([c.shop.address]), 0n, "HTTP previews never transfer tokens");
      assert.equal((await fetch(`${running.baseUrl}/agent/challenge`)).status, 404);
      assert.equal((await (await fetch(`${running.baseUrl}/activity`)).json()).events.some((event: { source: string }) => event.source === "agent"), true);
    } finally { await Promise.all([running.close(), otherWorker.close()]); }
  });
});
