import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { concatHex, encodeFunctionData, keccak256, parseUnits, toBytes, toHex, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { p256 } from "@noble/curves/nist.js";
import { Decision, encodePolicy, isExpectedAgentClone, ownerActionTypedData, requestAuthenticationDigest, encodeRequestAuthenticationProof } from "../sdk/core.js";
import { createAgentSdk } from "../sdk/agent.js";
import { AgenticWorld, type AuthenticationChallenge, type Session } from "../sdk/service.js";

const mode = `0x${"00".repeat(32)}` as Hex;
const salt = `0x${"42".repeat(32)}` as Hex;

async function setup() {
  const { viem } = await hre.network.create();
  const [owner, stranger] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const entryPoint = await viem.deployContract("MockAgentEntryPoint");
  const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
  const implementation = await factory.read.implementation() as Address;
  const agent = await factory.read.predictAgent([owner.account.address, salt]) as Address;
  const authenticator = privateKeyToAccount(generatePrivateKey());
  const hash = await factory.write.createAgent([authenticator.address, salt]);
  await publicClient.waitForTransactionReceipt({ hash });
  const account = await viem.getContractAt("AgentAccount4337", agent);
  return { viem, owner, stranger, publicClient, entryPoint, factory, implementation, agent, authenticator, account };
}

function single(target: Address, value: bigint, data: Hex): Hex {
  return concatHex([target, toHex(value, { size: 32 }), data]);
}

function packedOp(sender: Address, callData: Hex, signature: Hex) {
  return {
    sender, nonce: 0n, initCode: "0x" as Hex, callData,
    accountGasLimits: mode, preVerificationGas: 0n, gasFees: mode,
    paymasterAndData: "0x" as Hex, signature,
  };
}

describe("Agentic World v0 ERC-4337 / ERC-7579 account", () => {
  it("authenticates a P-256 operating key through ERC-1271 and ERC-4337 without exposing its private key", async () => {
    const { viem } = await hre.network.create();
    const [owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const entryPoint = await viem.deployContract("MockAgentEntryPoint");
    const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
    const agentId = await factory.read.predictAgent([owner.account.address, salt]) as Address;
    const secret = p256.utils.randomPrivateKey();
    const publicKey = p256.getPublicKey(secret, false);
    const qx = toHex(publicKey.slice(1, 33));
    const qy = toHex(publicKey.slice(33, 65));
    const created = await factory.write.createAgentP256([qx, qy, salt]);
    await publicClient.waitForTransactionReceipt({ hash: created });
    const account = await viem.getContractAt("AgentAccount4337", agentId);
    assert.equal(await account.read.authenticatorScheme(), 2);
    assert.equal(await account.read.protocolVersion(), 3n);
    assert.deepEqual(await account.read.authenticatorP256(), [qx, qy]);
    assert.equal((await account.read.owner() as Address).toLowerCase(), owner.account.address.toLowerCase());
    const signDigest = async (digest: Hex) => `0x${p256.sign(toBytes(digest), secret, { prehash: false }).toCompactHex()}` as Hex;
    const agent = createAgentSdk({ agentId, chainId: await publicClient.getChainId(), signDigest });
    const request = { method: "GET", target: "/private/report", body: new Uint8Array() };
    const proof = await agent.signRequest(request, "https://service-a.example");
    const digest = requestAuthenticationDigest(proof);
    const nativeSignature = await signDigest(digest);
    const native = await publicClient.call({ to: "0x0000000000000000000000000000000000000100",
      data: concatHex([digest, nativeSignature.slice(0, 66) as Hex, `0x${nativeSignature.slice(66)}` as Hex, qx, qy]) });
    assert.equal(native.data, toHex(1n, { size: 32 }), "EIP-7951 precompile must verify on the Osaka test chain");
    assert.equal(await account.read.isValidSignature([digest, encodeRequestAuthenticationProof(proof)]), "0x1626ba7e");
    const sessions = new Map<Hex, Session>();
    const nonces = new Set<Hex>();
    const challenges = new Map<Hex, AuthenticationChallenge>();
    const consumedChallenges = new Set<Hex>();
    let admitted = 0;
    let allowSession = false;
    const service = new AgenticWorld({ client: publicClient, chainId: await publicClient.getChainId(),
      audience: "https://service-a.example", pinnedImplementation: await factory.read.implementation() as Address,
      requestNonces: { async consume(_id, nonce) { if (nonces.has(nonce)) return false; nonces.add(nonce); return true; } },
      challenges: {
        async put(challenge) { challenges.set(challenge.nonce, challenge); },
        async get(nonce) { return consumedChallenges.has(nonce) ? undefined : challenges.get(nonce); },
        async consume(nonce) {
          if (consumedChallenges.has(nonce) || !challenges.has(nonce)) return false;
          consumedChallenges.add(nonce);
          return true;
        },
      },
      sessions: { async put(hash, session) { sessions.set(hash, session); }, async get(hash) { return sessions.get(hash); } },
      association: { mode: "owner", async resolveUser(address) { return address.toLowerCase() === owner.account.address.toLowerCase() ? { id: "owner" } : null; } },
      authorizeSession: async (_identity, user) => { admitted += 1; return allowSession && user.id === "owner"; },
    });
    assert.equal((await service.authenticateRequest(proof, request)).user?.id, "owner");
    const deniedChallenge = await service.createChallenge(agentId);
    const deniedProof = await agent.answerChallenge(deniedChallenge, "https://service-a.example");
    const existingSessions = sessions.size;
    await assert.rejects(service.authenticate(deniedProof));
    assert.equal(sessions.size, existingSessions, "denied agent must not receive a session");
    await assert.rejects(service.authenticate(deniedProof), "denied challenge is still consumed");
    allowSession = true;
    const challenge = await service.createChallenge(agentId);
    const challengeProof = await agent.answerChallenge(challenge, "https://service-a.example");
    const established = await service.authenticate(challengeProof);
    assert.equal(established.user?.id, "owner");
    assert.equal(admitted, 2);
    assert.equal((await service.readSession(established.token))?.session.agentId, agentId);
    await assert.rejects(service.authenticate(challengeProof));
    const userOpHash = keccak256(toBytes("p256-userop"));
    const op = packedOp(agentId, "0x", await signDigest(userOpHash));
    assert.equal(await publicClient.simulateContract({ address: entryPoint.address, abi: entryPoint.abi,
      functionName: "validate", args: [agentId, op, userOpHash] }).then(r => r.result), 0n);
    const revoked = await owner.writeContract({ address: agentId, abi: account.abi, functionName: "revokeAuthenticator" });
    await publicClient.waitForTransactionReceipt({ hash: revoked });
    assert.equal(await account.read.isValidSignature([digest, encodeRequestAuthenticationProof(proof)]), "0xffffffff");
    assert.equal(await publicClient.simulateContract({ address: entryPoint.address, abi: entryPoint.abi,
      functionName: "validate", args: [agentId, op, userOpHash] }).then(r => r.result), 1n);
  });
  it("deploys an initialized clone with owner = factory transaction sender and fixed modules", async () => {
    const c = await setup();
    const code = await c.publicClient.getCode({ address: c.agent });
    assert.equal(isExpectedAgentClone(code, c.implementation), true);
    assert.equal((await c.account.read.owner() as Address).toLowerCase(), c.owner.account.address.toLowerCase());
    assert.equal((await c.account.read.authenticator() as Address).toLowerCase(), c.authenticator.address.toLowerCase());
    assert.equal(await c.account.read.protocolVersion(), 2n);
    assert.equal(await c.account.read.isModuleInstalled([1n, await c.factory.read.validator() as Address, "0x"]), true);
    assert.equal(await c.account.read.isModuleInstalled([4n, await c.factory.read.policyHook() as Address, "0x"]), true);
    await assert.rejects(c.stranger.writeContract({ address: c.agent, abi: c.account.abi, functionName: "initialize", args: [c.stranger.account.address, c.authenticator.address] }));
    await assert.rejects(c.owner.writeContract({ address: c.agent, abi: c.account.abi, functionName: "uninstallModule", args: [4n, await c.factory.read.policyHook() as Address, "0x"] }));
  });

  it("validates UserOperations only through the EntryPoint and current KMS signer", async () => {
    const c = await setup();
    const digest = keccak256(toBytes("user-operation-v0"));
    const sig = await c.authenticator.sign({ hash: digest });
    const op = packedOp(c.agent, "0x", sig);
    assert.equal(await c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "validate", args: [c.agent, op, digest] }).then(r => r.result), 0n);
    const wrong = privateKeyToAccount(generatePrivateKey());
    const wrongOp = packedOp(c.agent, "0x", await wrong.sign({ hash: digest }));
    assert.equal(await c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "validate", args: [c.agent, wrongOp, digest] }).then(r => r.result), 1n);
    await assert.rejects(c.publicClient.simulateContract({ address: c.agent, abi: c.account.abi, functionName: "validateUserOp", args: [op, digest, 0n] }));
    const revoke = await c.owner.writeContract({ address: c.agent, abi: c.account.abi, functionName: "revokeAuthenticator" });
    await c.publicClient.waitForTransactionReceipt({ hash: revoke });
    assert.equal(await c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "validate", args: [c.agent, op, digest] }).then(r => r.result), 1n);
  });

  it("keeps the existing request-bound ERC-1271 proof format", async () => {
    const c = await setup();
    const chainId = await c.publicClient.getChainId();
    const now = Math.floor(Date.now() / 1000);
    const proof = {
      agentId: c.agent, audience: "https://service-a.example", chainId,
      nonce: `0x${"ab".repeat(32)}` as Hex, issuedAt: now, expiresAt: now + 60,
      method: "GET", target: "/private/report", bodyHash: keccak256(new Uint8Array()),
    };
    const digest = requestAuthenticationDigest(proof);
    const signature = await c.authenticator.sign({ hash: digest });
    assert.equal(await c.account.read.isValidSignature([digest, encodeRequestAuthenticationProof({ ...proof, signature })]), "0x1626ba7e");
    assert.equal(await c.account.read.isValidSignature([digest, encodeRequestAuthenticationProof({ ...proof, signature: await privateKeyToAccount(generatePrivateKey()).sign({ hash: digest }) })]), "0xffffffff");
  });

  it("keeps the service-facing manual/owner API while verifying the v0 clone", async () => {
    const c = await setup();
    const chainId = await c.publicClient.getChainId();
    const now = Math.floor(Date.now() / 1000);
    const agent = createAgentSdk({ agentId: c.agent, chainId, now: () => now,
      signDigest: digest => c.authenticator.sign({ hash: digest }) });
    const nonceKeys = new Set<string>();
    const sessions = new Map<Hex, Session>();
    const service = new AgenticWorld({
      client: c.publicClient, chainId, audience: "https://service-a.example",
      pinnedImplementation: c.implementation, now: () => now,
      requestNonces: { async consume(id, nonce) {
        const key = `${id.toLowerCase()}:${nonce.toLowerCase()}`;
        if (nonceKeys.has(key)) return false;
        nonceKeys.add(key);
        return true;
      } },
      sessions: { async put(hash, session) { sessions.set(hash, session); }, async get(hash) { return sessions.get(hash); } },
      association: { mode: "owner", async resolveUser(owner) {
        return owner.toLowerCase() === c.owner.account.address.toLowerCase() ? { id: "human-customer" } : null;
      } },
    });
    const request = { method: "GET", target: "/private/report", body: new Uint8Array() };
    const proof = await agent.signRequest(request, "https://service-a.example");
    const result = await service.authenticateRequest(proof, request);
    assert.equal(result.user?.id, "human-customer");
    assert.equal(result.session.owner?.toLowerCase(), c.owner.account.address.toLowerCase());
    await assert.rejects(service.authenticateRequest(proof, request));
  });

  it("enforces the separate policy hook on EntryPoint execution and owner approvals", async () => {
    const c = await setup();
    const target = await c.viem.deployContract("PolicyActionTarget");
    const data = encodeFunctionData({ abi: target.abi, functionName: "purchase", args: [keccak256(toBytes("compute"))] });
    const execution = single(target.address, 0n, data);
    const run = (functionName: "execute" | "executeWithApproval", args: readonly unknown[]) =>
      encodeFunctionData({ abi: c.account.abi, functionName, args: args as never });
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "run", args: [c.agent, run("execute", [mode, execution])] }));
    const encoded = encodePolicy([{ target: target.address, selector: data.slice(0, 10) as Hex, token: zeroAddress,
      maxValue: 0n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE }]);
    const saved = await c.owner.writeContract({ address: c.agent, abi: c.account.abi, functionName: "setPolicy", args: [encoded] });
    await c.publicClient.waitForTransactionReceipt({ hash: saved });
    const policyChange = encodeFunctionData({ abi: c.account.abi, functionName: "setPolicy", args: [encoded] });
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
      functionName: "run", args: [c.agent, policyChange] }));
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
      functionName: "run", args: [c.agent, run("execute", [mode, single(c.agent, 0n, policyChange)])] }));
    const batchMode = `0x01${"00".repeat(31)}` as Hex;
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
      functionName: "run", args: [c.agent, run("execute", [batchMode, execution])] }));
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "run", args: [c.agent, run("execute", [mode, execution])] }));
    const chainId = await c.publicClient.getChainId();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const action = ownerActionTypedData({ agent: c.agent, chainId, target: target.address, value: 0n, data,
      policyHash: await c.account.read.policyHash() as Hex, policyRevision: await c.account.read.policyRevision() as bigint,
      nonce: 0n, deadline });
    const approval = await c.owner.signTypedData(action);
    const callData = run("executeWithApproval", [mode, execution, 0n, deadline, approval]);
    const hash = await c.owner.writeContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "run", args: [c.agent, callData] });
    await c.publicClient.waitForTransactionReceipt({ hash });
    assert.equal(await target.read.calls(), 1n);
    assert.equal(await c.account.read.ownerApprovalNonce(), 1n);
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi, functionName: "run", args: [c.agent, callData] }));
    await assert.rejects(c.owner.writeContract({ address: c.agent, abi: c.account.abi, functionName: "execute", args: [mode, execution] }));
  });

  it("keeps the 2/20 token policy in the hook and rejects overcharge", async () => {
    const c = await setup();
    const token = await c.viem.deployContract("PolicyDemoUSDC");
    const shop = await c.viem.deployContract("PolicyActionTarget");
    const amount2 = parseUnits("2", 6);
    const amount20 = parseUnits("20", 6);
    const mint = await token.write.mint([c.agent, parseUnits("100", 6)]);
    await c.publicClient.waitForTransactionReceipt({ hash: mint });
    const approveData = encodeFunctionData({ abi: token.abi, functionName: "approve", args: [shop.address, parseUnits("100", 6)] });
    const purchaseData = (amount: bigint) => encodeFunctionData({ abi: shop.abi, functionName: "purchaseCompute", args: [token.address, amount] });
    const policy = encodePolicy([
      { target: token.address, selector: approveData.slice(0, 10) as Hex, token: zeroAddress,
        maxValue: 0n, maxAmount: 0n, decision: Decision.ALLOW },
      { target: shop.address, selector: purchaseData(amount2).slice(0, 10) as Hex, token: token.address,
        maxValue: 0n, maxAmount: amount2, decision: Decision.ALLOW },
      { target: shop.address, selector: purchaseData(amount20).slice(0, 10) as Hex, token: token.address,
        maxValue: 0n, maxAmount: amount20, decision: Decision.REQUIRE_OWNER_SIGNATURE },
    ]);
    const saved = await c.owner.writeContract({ address: c.agent, abi: c.account.abi, functionName: "setPolicy", args: [policy] });
    await c.publicClient.waitForTransactionReceipt({ hash: saved });
    const call = (target: Address, data: Hex, approval?: { nonce: bigint; deadline: bigint; signature: Hex }) =>
      encodeFunctionData({ abi: c.account.abi, functionName: approval ? "executeWithApproval" : "execute",
        args: approval ? [mode, single(target, 0n, data), approval.nonce, approval.deadline, approval.signature] as never
          : [mode, single(target, 0n, data)] as never });
    for (const data of [approveData, purchaseData(amount2)]) {
      const hash = await c.owner.writeContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
        functionName: "run", args: [c.agent, call(data === approveData ? token.address : shop.address, data)] });
      await c.publicClient.waitForTransactionReceipt({ hash });
    }
    assert.equal(await token.read.balanceOf([c.agent]), parseUnits("98", 6));
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
      functionName: "run", args: [c.agent, call(shop.address, purchaseData(amount20))] }));
    const data20 = purchaseData(amount20);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const approval = await c.owner.signTypedData(ownerActionTypedData({ agent: c.agent,
      chainId: await c.publicClient.getChainId(), target: shop.address, value: 0n, data: data20,
      policyHash: await c.account.read.policyHash() as Hex,
      policyRevision: await c.account.read.policyRevision() as bigint, nonce: 0n, deadline }));
    const bought = await c.owner.writeContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
      functionName: "run", args: [c.agent, call(shop.address, data20, { nonce: 0n, deadline, signature: approval })] });
    await c.publicClient.waitForTransactionReceipt({ hash: bought });
    assert.equal(await token.read.balanceOf([c.agent]), parseUnits("78", 6));
    const surcharge = await shop.write.setExtraCharge([1n]);
    await c.publicClient.waitForTransactionReceipt({ hash: surcharge });
    await assert.rejects(c.publicClient.simulateContract({ address: c.entryPoint.address, abi: c.entryPoint.abi,
      functionName: "run", args: [c.agent, call(shop.address, purchaseData(amount2))] }));
    assert.equal(await token.read.balanceOf([c.agent]), parseUnits("78", 6));
  });
});
