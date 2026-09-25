import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { concatHex, encodeAbiParameters, encodeFunctionData, keccak256, toFunctionSelector, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { Decision, encodePolicy, ownerActionTypedData } from "../sdk/agent.js";

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
  const rootPermit = await agentRoot.signTypedData({
    domain: { name: "Agentic World AgentAccount", version: "1", chainId, verifyingContract: agentRoot.address },
    types: { AgentInitialization: [
      { name: "agent", type: "address" }, { name: "owner", type: "address" },
      { name: "authenticator", type: "address" }, { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint64" },
    ] },
    primaryType: "AgentInitialization",
    message: { agent: agentRoot.address, owner: ownerAddress, authenticator: authenticator.account.address, nonce: 0n, deadline },
  });
  const initTx = ownerContract
    ? await human.writeContract({ address: ownerContract.address, abi: ownerContract.abi, functionName: "initializeAgent", args: [agentRoot.address, authenticator.account.address, 0n, deadline, rootPermit] })
    : await human.writeContract({ address: agentRoot.address, abi: implementation.abi, functionName: "initialize", args: [authenticator.account.address, 0n, deadline, rootPermit] });
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
  return { human, authenticator, stranger, client, agentRoot, implementation, target, ownerAddress, ownerContract, chainId, deadline, data, setPolicy, execute, rejectExecution, signApproval };
}

describe("AgentAccount execution policy", () => {
  it("stores only owner-defined canonical rules and defaults to DENY", async () => {
    const c = await setup();
    const label = keccak256("0x01");
    await c.rejectExecution(2n, c.data(label));
    assert.equal(await c.client.readContract({ address: c.agentRoot.address, abi: c.implementation.abi, functionName: "evaluateAction", args: [c.target.address, 2n, c.data(label)] }), Decision.DENY);

    const policy = encodePolicy([{ target: c.target.address, selector, maxValue: 2n, decision: Decision.ALLOW }]);
    await assert.rejects(c.client.simulateContract({ account: c.authenticator.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: [policy] }));
    await assert.rejects(c.client.simulateContract({ account: c.stranger.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: [policy] }));
    await assert.rejects(c.client.simulateContract({ account: c.human.account, address: c.agentRoot.address, abi: c.implementation.abi, functionName: "setPolicy", args: ["0x1234"] }));
    const unknownVersion = encodeAbiParameters([{ type: "uint8" }, { type: "tuple[]", components: [
      { name: "target", type: "address" }, { name: "selector", type: "bytes4" },
      { name: "maxValue", type: "uint256" }, { name: "decision", type: "uint8" },
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
      { target: c.target.address, selector, maxValue: 2n, decision: Decision.ALLOW },
      { target: c.target.address, selector, maxValue: 20n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
      { target: c.stranger.account.address, selector, maxValue: 20n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
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
      { target: c.target.address, selector, maxValue: 2n, decision: Decision.DENY },
      { target: c.target.address, selector, maxValue: 20n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
    ]));
    await c.rejectExecution(20n, c.data(sensitive), nextApproval);
    await c.rejectExecution(2n, c.data(small), await c.signApproval(2n, c.data(small)));
    await c.setPolicy(policy);
    await c.rejectExecution(20n, c.data(sensitive), nextApproval);
  });

  it("accepts an ERC-1271 owner approval against the current contract owner", async () => {
    const c = await setup(true);
    const label = keccak256("0x03");
    await c.setPolicy(encodePolicy([{ target: c.target.address, selector, maxValue: 20n, decision: Decision.REQUIRE_OWNER_SIGNATURE }]));
    await c.rejectExecution(20n, c.data(label));
    await c.execute(20n, c.data(label), await c.signApproval(20n, c.data(label)));
    assert.equal(await c.client.readContract({ address: c.target.address, abi: c.target.abi, functionName: "calls" }), 1n);
  });
});
