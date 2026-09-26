import assert from "node:assert/strict";
import { test } from "node:test";
import hre from "hardhat";
import { p256 } from "@noble/curves/nist.js";
import { encodeFunctionData, erc20Abi, parseEther, toHex, toBytes, type Address, type Hex } from "viem";
import { toPackedUserOperation, getUserOperationHash } from "viem/account-abstraction";
import { createPaymentExecutor, executionDigest, wrapExecutionSignature, type PaymentRecord, type PaymentOperation, type BundlerRpc } from "../sdk/payments.js";
import { encodeTransferPolicy, Decision } from "../sdk/policy.js";
import { encodeAgentExecution } from "../sdk/execution.js";

test("USDC execution: real EntryPoint transfers, owner approval, denial and retry safety", async () => {
  const { viem } = await hre.network.create();
  const [owner, recipient, stranger] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  const chainId = await client.getChainId();
  const ep = await viem.deployContract("RealEntryPoint");
  const factory = await viem.deployContract("AgentAccountFactory", [ep.address]);
  const secret = p256.utils.randomPrivateKey();
  const pub = p256.getPublicKey(secret, false);
  const salt = toHex(937n, { size: 32 });
  const agent = await factory.read.predictAgent([owner.account.address, salt]) as Address;
  await client.waitForTransactionReceipt({ hash: await factory.write.createAgentP256([toHex(pub.slice(1, 33)), toHex(pub.slice(33)), salt]) });
  const account = await viem.getContractAt("AgentAccount4337", agent);
  const token = await viem.deployContract("PolicyDemoUSDC");
  await token.write.mint([agent, 100_000_000n]);
  await owner.sendTransaction({ to: agent, value: parseEther("0.1") });
  const policy = encodeTransferPolicy([
    { token: token.address, recipient: recipient.account.address, maxAmount: 5_000_000n, decision: Decision.ALLOW },
    { token: token.address, recipient: recipient.account.address, maxAmount: 20_000_000n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
  ]);
  await account.write.setPolicy([policy]);
  const records = new Map<string, PaymentRecord>();
  const receipts = new Map<string, Hex>();
  let approvals = 0, sends = 0;
  let ambiguous = false, changePolicy = false;
  const bundler: BundlerRpc = { async request(method, params) {
    if (method === "eth_supportedEntryPoints") return [ep.address];
    if (method === "pimlico_getUserOperationGasPrice") return { standard: { maxFeePerGas: toHex(2_000_000_000n), maxPriorityFeePerGas: toHex(1_000_000_000n) } };
    if (method === "eth_estimateUserOperationGas") return { callGasLimit: toHex(400_000n), verificationGasLimit: toHex(400_000n), preVerificationGas: toHex(50_000n) };
    if (method === "eth_getUserOperationReceipt") { const tx = receipts.get(params[0] as string); return tx ? { receipt: { transactionHash: tx } } : null; }
    assert.equal(method, "eth_sendUserOperation");
    sends++;
    const raw = params[0] as Record<string, any>;
    const operation = { ...raw } as PaymentOperation;
    for (const key of ["nonce", "callGasLimit", "verificationGasLimit", "preVerificationGas", "maxFeePerGas", "maxPriorityFeePerGas"] as const) operation[key] = BigInt(raw[key]);
    const hash = getUserOperationHash({ chainId, entryPointAddress: ep.address, entryPointVersion: "0.8", userOperation: operation });
    const packed = toPackedUserOperation(operation);
    assert.equal(await ep.read.getUserOpHash([packed]), hash, "local hash must match the actual EntryPoint");
    if (changePolicy) await account.write.setPolicy([encodeTransferPolicy([])]);
    const tx = await ep.write.handleOps([[packed], owner.account.address]);
    await client.waitForTransactionReceipt({ hash: tx });
    receipts.set(hash, tx);
    if (ambiguous) throw new Error("Connection lost after submission");
    return hash;
  } };
  const executor = createPaymentExecutor({ client, chainId, implementation: await factory.read.implementation() as Address,
    token: token.address, entryPoint: ep.address, bundler,
    journal: { async get(id) { return records.get(id); }, async put(record) { records.set(record.requestId, record); } },
    sign: async request => {
      const op = request.userOperation;
      const digest = executionDigest(chainId, ep.address, { sender: op.sender, nonce: BigInt(op.nonce), callData: op.callData,
        verificationGasLimit: BigInt(op.accountGasLimits.slice(0, 34)), callGasLimit: BigInt(`0x${op.accountGasLimits.slice(34)}`),
        preVerificationGas: BigInt(op.preVerificationGas), maxPriorityFeePerGas: BigInt(op.gasFees.slice(0, 34)), maxFeePerGas: BigInt(`0x${op.gasFees.slice(34)}`), signature: "0x" }, request.validUntil);
      return toHex(p256.sign(toBytes(digest), secret, { prehash: false }).toCompactRawBytes());
    },
    approve: async typed => { approvals++; return owner.signTypedData(typed); },
  });
  const intent = { agentId: agent, recipient: recipient.account.address, amount: "5" };
  assert.equal((await executor.pay("allow-0001", intent)).status, "SUBMITTED");
  assert.equal((await executor.status("allow-0001")).status, "CONFIRMED");
  assert.equal(await token.read.balanceOf([recipient.account.address]), 5_000_000n);
  assert.equal(approvals, 0);
  assert.equal((await executor.pay("allow-0001", intent)).status, "CONFIRMED");
  assert.equal(sends, 1, "same request ID must not transfer twice");
  await assert.rejects(executor.pay("allow-0001", { ...intent, amount: "6" }), /different payment/);
  assert.equal((await executor.pay("approve-01", { ...intent, amount: "20" })).status, "SUBMITTED");
  assert.equal((await executor.status("approve-01")).status, "CONFIRMED");
  assert.equal(approvals, 1);
  assert.equal(await token.read.balanceOf([recipient.account.address]), 25_000_000n);
  assert.equal(await account.read.ownerApprovalNonce(), 1n);
  assert.match((await executor.pay("denied-001", { ...intent, amount: "20.000001" })).error!, /POLICY_DENIED/);
  assert.match((await executor.pay("wrong-recipient", { ...intent, recipient: stranger.account.address })).error!, /POLICY_DENIED/);
  assert.equal(sends, 2);
  ambiguous = true;
  assert.equal((await executor.pay("unknown-01", { ...intent, amount: "1" })).status, "UNKNOWN");
  assert.equal((await executor.pay("unknown-01", { ...intent, amount: "1" })).status, "CONFIRMED");
  assert.equal((await executor.status("unknown-01")).error, undefined, "a reconciled payment must not retain its old unknown-submission warning");
  assert.equal(sends, 3, "ambiguous response must be reconciled, never resent");
  ambiguous = false; changePolicy = true;
  await executor.pay("changed-policy", { ...intent, amount: "1" });
  assert.equal((await executor.status("changed-policy")).status, "REVERTED");
  assert.equal(await token.read.balanceOf([recipient.account.address]), 26_000_000n);
  assert.equal(await token.read.balanceOf([agent]), 74_000_000n);
  // Policy is checked onchain, even if the offchain preview was allowed earlier.
  assert.equal(await account.read.evaluateAction([token.address, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient.account.address, 1n] })]), Decision.DENY);
  // Replay of the old operation cannot pass the EntryPoint nonce.
  await assert.rejects(ep.write.handleOps([[toPackedUserOperation(records.get("allow-0001")!.operation!)], owner.account.address]));
  const stale: PaymentOperation = { ...records.get("allow-0001")!.operation!, nonce: await ep.read.getNonce([agent, 0n]) as bigint,
    callData: encodeAgentExecution(token.address, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient.account.address, 1n] })) };
  const expired = Number((await client.getBlock()).timestamp) - 1;
  stale.signature = wrapExecutionSignature(expired, toHex(p256.sign(toBytes(executionDigest(chainId, ep.address, stale, expired)), secret, { prehash: false }).toCompactRawBytes()));
  await assert.rejects(ep.write.handleOps([[toPackedUserOperation(stale)], owner.account.address]));
});
