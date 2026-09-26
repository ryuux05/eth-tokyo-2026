import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, toFunctionSelector, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Decision, TOKEN_PURCHASE_SELECTOR, agentAccountAbi, agentInitializationTypedData, decodePolicy, encodePolicy, ownerActionTypedData } from "../sdk/core.js";

const selector = toFunctionSelector("purchase(bytes32)");
const noApproval = { nonce: 0n, deadline: 0n, signature: "0x" as Hex };

async function setup(contractOwner = false) {
  const { viem } = await hre.network.create();
  const [human, authenticator, stranger] = await viem.getWalletClients();
  const client = await viem.getPublicClient();
  const agentRoot = privateKeyToAccount(generatePrivateKey());
  const implementation = await viem.deployContract("AgentAccount");
  const target = await viem.deployContract("PolicyActionTarget");
  const chainId = await client.getChainId();
  const ownerContract = contractOwner
    ? await viem.deployContract("PolicyContractOwner", [human.account.address])
    : undefined;
  const ownerAddress = ownerContract?.address ?? human.account.address;
  const authorization = await human.signAuthorization({ account: agentRoot, contractAddress: implementation.address });
  const delegationTx = await human.sendTransaction({ to: human.account.address, value: 0n, authorizationList: [authorization] });
  await client.waitForTransactionReceipt({ hash: delegationTx });
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const rootPermit = await agentRoot.signTypedData(agentInitializationTypedData({
    agent: agentRoot.address, owner: ownerAddress, authenticator: authenticator.account.address,
    chainId, nonce: 0n, deadline,
  }));
  const initTx = ownerContract
    ? await human.writeContract({ address: ownerContract.address, abi: ownerContract.abi, functionName: "initializeAgent", args: [agentRoot.address, authenticator.account.address, 0n, deadline, rootPermit] })
    : await human.writeContract({ address: agentRoot.address, abi: agentAccountAbi, functionName: "initialize", args: [authenticator.account.address, 0n, deadline, rootPermit] });
  await client.waitForTransactionReceipt({ hash: initTx });
  const fundTx = await human.sendTransaction({ to: agentRoot.address, value: 100n });
  await client.waitForTransactionReceipt({ hash: fundTx });

  const data = (label: Hex) => encodeFunctionData({ abi: target.abi, functionName: "purchase", args: [label] });
  const setPolicy = async (encoded: Hex) => {
    const tx = ownerContract
      ? await human.writeContract({ address: ownerContract.address, abi: ownerContract.abi, functionName: "setAgentPolicy", args: [agentRoot.address, encoded] })
      : await human.writeContract({ address: agentRoot.address, abi: implementation.abi, functionName: "setPolicy", args: [encoded] });
    await client.waitForTransactionReceipt({ hash: tx });
  };
  const execute = async (value: bigint, payload: Hex, approval = noApproval, destination: Address = target.address) => {
    const tx = await authenticator.writeContract({ address: agentRoot.address, abi: implementation.abi, functionName: "execute", args: [destination, value, payload, approval] });
    await client.waitForTransactionReceipt({ hash: tx });
  };
  const rejectExecution = (value: bigint, payload: Hex, approval = noApproval, destination: Address = target.address) =>
    assert.rejects(client.simulateContract({ account: authenticator.account, address: agentRoot.address, abi: implementation.abi, functionName: "execute", args: [destination, value, payload, approval] }));
  const signApproval = async (value: bigint, payload: Hex, overrides: Partial<{
    agent: Address; chainId: number; target: Address; value: bigint; data: Hex; policyHash: Hex; policyRevision: bigint; nonce: bigint; deadline: bigint;
  }> = {}, signer = human) => {
    const nonce = await client.readContract({ address: agentRoot.address, abi: implementation.abi, functionName: "ownerApprovalNonce" }) as bigint;
    const policyHash = await client.readContract({ address: agentRoot.address, abi: implementation.abi, functionName: "policyHash" }) as Hex;
    const policyRevision = await client.readContract({ address: agentRoot.address, abi: implementation.abi, functionName: "policyRevision" }) as bigint;
    const action = { agent: agentRoot.address, chainId, target: target.address, value, data: payload, policyHash, policyRevision, nonce, deadline, ...overrides };
    const signature = await signer.signTypedData(ownerActionTypedData(action));
    return { nonce: action.nonce, deadline: action.deadline, signature };
  };
  return { viem, human, authenticator, stranger, client, agentRoot, implementation, target, ownerAddress, ownerContract, chainId, deadline, data, setPolicy, execute, rejectExecution, signApproval };
}

describe("AgentAccount execution policy", () => {
  it("stores only owner-defined canonical rules and defaults to DENY", async () => {
    const c = await setup();
    const label = keccak256("0x01");
    await c.rejectExecution(2n, c.data(label));
    assert.equal(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "evaluateAction", args: [c.target.address, 2n, c.data(label)] }), Decision.DENY);

    const policy = encodePolicy([{ target: c.target.address, selector, token: zeroAddress, maxValue: 2n, maxAmount: 0n, decision: Decision.ALLOW }]);
    assert.equal(encodePolicy(decodePolicy(policy)), policy);
    await assert.rejects(c.client.simulateContract({ account: c.authenticator.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: [policy] }));
    await assert.rejects(c.client.simulateContract({ account: c.stranger.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: [policy] }));
    await assert.rejects(c.client.simulateContract({ account: c.human.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: ["0x1234"] }));
    const unknownVersion = encodeAbiParameters([{ type: "uint8" }, { type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "selector", type: "bytes4" },
      { name: "token", type: "address" }, { name: "maxValue", type: "uint256" },
      { name: "maxAmount", type: "uint256" }, { name: "decision", type: "uint8" },
    ] }], [2, []]);
    await assert.rejects(c.client.simulateContract({ account: c.human.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: [unknownVersion] }));
    await assert.rejects(c.client.simulateContract({ account: c.human.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: [concatHex([policy, "0x00"])] }));
    await c.setPolicy(policy);
    assert.equal(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "policyHash" }), keccak256(policy));
    assert.equal(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "policy" }), policy);
    assert.equal(String(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "owner" })).toLowerCase(), c.ownerAddress.toLowerCase());
    await c.rejectExecution(3n, c.data(label));
    await c.rejectExecution(2n, c.data(label), noApproval, c.stranger.account.address);
    await c.execute(2n, c.data(label));
    assert.equal(await c.client.readContract({ address: c.target.address, abi: c.target.abi, functionName: "calls" }), 1n);
    assert.equal(await c.client.readContract({ address: c.target.address, abi: c.target.abi, functionName: "lastValue" }), 2n);
    const newAuthenticator = c.stranger.account.address;
    const rotateTx = await c.human.writeContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "rotateAuthenticator", args: [newAuthenticator] });
    await c.client.waitForTransactionReceipt({ hash: rotateTx });
    assert.equal(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "policy" }), policy);
    assert.equal(String(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "owner" })).toLowerCase(), c.ownerAddress.toLowerCase());
    await c.rejectExecution(2n, c.data(label));
  });

  it("requires exact owner approval, consumes a separate nonce, and never bypasses DENY", async () => {
    const c = await setup();
    const small = keccak256("0x01");
    const sensitive = keccak256("0x02");
    const policy = encodePolicy([
      { target: c.target.address, selector, token: zeroAddress, maxValue: 2n, maxAmount: 0n, decision: Decision.ALLOW },
      { target: c.target.address, selector, token: zeroAddress, maxValue: 20n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
      { target: c.stranger.account.address, selector, token: zeroAddress, maxValue: 20n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
    ]);
    await c.setPolicy(policy);
    await c.execute(2n, c.data(small));
    await c.rejectExecution(20n, c.data(sensitive));
    await c.rejectExecution(20n, c.data(sensitive), await c.signApproval(20n, c.data(sensitive), {}, c.stranger));
    const approval = await c.signApproval(20n, c.data(sensitive));
    await c.rejectExecution(19n, c.data(sensitive), approval);
    await c.rejectExecution(20n, c.data(small), approval);
    await c.rejectExecution(20n, c.data(sensitive), approval, c.stranger.account.address);
    await c.rejectExecution(20n, c.data(sensitive), await c.signApproval(20n, c.data(sensitive), { agent: c.stranger.account.address }));
    await c.rejectExecution(20n, c.data(sensitive), await c.signApproval(20n, c.data(sensitive), { chainId: c.chainId + 1 }));
    await c.rejectExecution(20n, c.data(sensitive), await c.signApproval(20n, c.data(sensitive), { deadline: 0n }));
    await c.rejectExecution(20n, c.data(sensitive), await c.signApproval(20n, c.data(sensitive), { nonce: 1n }));
    await c.execute(20n, c.data(sensitive), approval);
    assert.equal(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "ownerApprovalNonce" }), 1n);
    await c.rejectExecution(20n, c.data(sensitive), approval);
    const nextApproval = await c.signApproval(20n, c.data(sensitive));
    await c.rejectExecution(21n, c.data(sensitive), nextApproval);
    await c.rejectExecution(20n, c.data(sensitive), nextApproval, c.stranger.account.address);

    // Policy updates invalidate pre-signed approvals through policyHash binding.
    await c.setPolicy(encodePolicy([
      { target: c.target.address, selector, token: zeroAddress, maxValue: 2n, maxAmount: 0n, decision: Decision.DENY },
      { target: c.target.address, selector, token: zeroAddress, maxValue: 20n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
    ]));
    await c.rejectExecution(20n, c.data(sensitive), nextApproval);
    await c.rejectExecution(2n, c.data(small), await c.signApproval(2n, c.data(small)));
    await c.setPolicy(policy);
    await c.rejectExecution(20n, c.data(sensitive), nextApproval);
  });

  it("accepts an ERC-1271 owner approval against the current contract owner", async () => {
    const c = await setup(true);
    const label = keccak256("0x03");
    await c.setPolicy(encodePolicy([{ target: c.target.address, selector, token: zeroAddress, maxValue: 20n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE }]));
    await c.rejectExecution(20n, c.data(label));
    await c.execute(20n, c.data(label), await c.signApproval(20n, c.data(label)));
    assert.equal(await c.client.readContract({ address: c.target.address, abi: c.target.abi, functionName: "calls" }), 1n);
  });

  it("matches only the supported token purchase ABI and enforces $2/$20 thresholds", async () => {
    const c = await setup();
    const usdc = await c.viem.deployContract("PolicyDemoUSDC");
    const otherToken = await c.viem.deployContract("PolicyDemoUSDC");
    const mintTx = await c.human.writeContract({ address: usdc.address, abi: usdc.abi, functionName: "mint", args: [c.agentRoot.address, 100_000_000n] });
    await c.client.waitForTransactionReceipt({ hash: mintTx });
    const approveData = encodeFunctionData({ abi: usdc.abi, functionName: "approve", args: [c.target.address, 100_000_000n] });
    const purchaseData = (token: Address, amount: bigint) => encodeFunctionData({
      abi: c.target.abi, functionName: "purchaseCompute", args: [token, amount],
    });
    const rules = [
      { target: usdc.address, selector: toFunctionSelector("approve(address,uint256)"), token: zeroAddress, maxValue: 0n, maxAmount: 0n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
      { target: c.target.address, selector: TOKEN_PURCHASE_SELECTOR, token: usdc.address, maxValue: 0n, maxAmount: 5_000_000n, decision: Decision.ALLOW },
      { target: c.target.address, selector: TOKEN_PURCHASE_SELECTOR, token: usdc.address, maxValue: 0n, maxAmount: 100_000_000n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
    ] as const;
    const unsupportedTokenPolicy = encodeAbiParameters([{ type: "uint8" }, { type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "selector", type: "bytes4" },
      { name: "token", type: "address" }, { name: "maxValue", type: "uint256" },
      { name: "maxAmount", type: "uint256" }, { name: "decision", type: "uint8" },
    ] }], [1, [{ target: c.target.address, selector: toFunctionSelector("transfer(address,uint256)"), token: usdc.address,
      maxValue: 0n, maxAmount: 5_000_000n, decision: Decision.ALLOW }]]);
    await assert.rejects(c.client.simulateContract({ account: c.human.account, address: c.agentRoot.address,
      abi: c.implementation.abi, functionName: "setPolicy", args: [unsupportedTokenPolicy] }));
    await c.setPolicy(encodePolicy(rules));
    const preview = (target: Address, data: Hex) => c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "evaluateAction", args: [target, 0n, data] });
    assert.equal(await preview(c.target.address, purchaseData(usdc.address, 2_000_000n)), Decision.ALLOW);
    assert.equal(await preview(c.target.address, purchaseData(usdc.address, 20_000_000n)), Decision.REQUIRE_OWNER_SIGNATURE);
    assert.equal(await preview(c.target.address, purchaseData(usdc.address, 101_000_000n)), Decision.DENY);
    assert.equal(await preview(c.target.address, purchaseData(otherToken.address, 2_000_000n)), Decision.DENY);
    assert.equal(await preview(c.target.address, `${purchaseData(usdc.address, 2_000_000n)}00`), Decision.DENY);
    assert.equal(await preview(c.target.address, "0x1234"), Decision.DENY);
    assert.throws(() => encodePolicy([{ ...rules[1], selector: toFunctionSelector("transfer(address,uint256)") }]));

    await c.rejectExecution(0n, approveData, noApproval, usdc.address);
    await c.execute(0n, approveData, await c.signApproval(0n, approveData, { target: usdc.address }), usdc.address);
    const overchargeTx = await c.human.writeContract({ address: c.target.address, abi: c.target.abi, functionName: "setExtraCharge", args: [10_000_000n] });
    await c.client.waitForTransactionReceipt({ hash: overchargeTx });
    await c.rejectExecution(0n, purchaseData(usdc.address, 2_000_000n));
    assert.equal(await c.client.readContract({ address: usdc.address, abi: usdc.abi, functionName: "balanceOf", args: [c.target.address] }), 0n);
    const clearChargeTx = await c.human.writeContract({ address: c.target.address, abi: c.target.abi, functionName: "setExtraCharge", args: [0n] });
    await c.client.waitForTransactionReceipt({ hash: clearChargeTx });
    await c.execute(0n, purchaseData(usdc.address, 2_000_000n));
    await c.rejectExecution(0n, purchaseData(usdc.address, 20_000_000n));
    await c.execute(0n, purchaseData(usdc.address, 20_000_000n), await c.signApproval(0n, purchaseData(usdc.address, 20_000_000n)));
    assert.equal(await c.client.readContract({ address: c.target.address, abi: c.target.abi, functionName: "lastAmount" }), 20_000_000n);
    assert.equal(await c.client.readContract({ address: usdc.address, abi: usdc.abi, functionName: "balanceOf", args: [c.target.address] }), 22_000_000n);
  });
});
