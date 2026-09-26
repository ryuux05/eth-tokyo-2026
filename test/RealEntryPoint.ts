import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { concatHex, encodeFunctionData, keccak256, parseAbiItem, parseEther, parseEventLogs, toBytes, toHex, zeroAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAgentSdk, Decision, encodeAgentExecution, encodePolicy } from "../sdk/agent.js";
import { AgenticWorld, type Session } from "../sdk/service.js";

const salt = `0x${"43".repeat(32)}` as Hex;
const gasLimits = concatHex([toHex(1_000_000n, { size: 16 }), toHex(500_000n, { size: 16 })]);
const gasFees = concatHex([toHex(1_000_000_000n, { size: 16 }), toHex(2_000_000_000n, { size: 16 })]);
const userOperationEvent = parseAbiItem("event UserOperationEvent(bytes32 indexed userOpHash,address indexed sender,address indexed paymaster,uint256 nonce,bool success,uint256 actualGasCost,uint256 actualGasUsed)");

describe("Agentic World through the official ERC-4337 EntryPoint", () => {
  it("executes a signed, policy-allowed UserOperation and rejects signature/nonce replay", async () => {
    const { viem } = await hre.network.create();
    const [owner] = await viem.getWalletClients();
    const publicClient = await viem.getPublicClient();
    const entryPoint = await viem.deployContract("RealEntryPoint");
    const factory = await viem.deployContract("AgentAccountFactory", [entryPoint.address]);
    const authenticator = privateKeyToAccount(generatePrivateKey());
    const agent = await factory.read.predictAgent([owner.account.address, salt]) as Address;
    const created = await factory.write.createAgent([authenticator.address, salt]);
    await publicClient.waitForTransactionReceipt({ hash: created });
    const account = await viem.getContractAt("AgentAccount4337", agent);
    const target = await viem.deployContract("PolicyActionTarget");
    const data = encodeFunctionData({ abi: target.abi, functionName: "purchase", args: [keccak256(toBytes("local-e2e"))] });
    const policy = encodePolicy([{ target: target.address, selector: data.slice(0, 10) as Hex,
      token: zeroAddress, maxValue: 0n, maxAmount: 0n, decision: Decision.ALLOW }]);
    const configured = await owner.writeContract({ address: agent, abi: account.abi, functionName: "setPolicy", args: [policy] });
    await publicClient.waitForTransactionReceipt({ hash: configured });
    const funded = await entryPoint.write.depositTo([agent], { value: parseEther("0.01") });
    await publicClient.waitForTransactionReceipt({ hash: funded });

    const sdk = createAgentSdk({ agentId: agent, chainId: await publicClient.getChainId(),
      signDigest: hash => authenticator.sign({ hash }) });
    const unsigned = {
      sender: agent,
      nonce: await entryPoint.read.getNonce([agent, 0n]),
      initCode: "0x" as Hex,
      callData: encodeAgentExecution(target.address, 0n, data),
      accountGasLimits: gasLimits,
      preVerificationGas: 100_000n,
      gasFees,
      paymasterAndData: "0x" as Hex,
      signature: "0x" as Hex,
    };
    const userOpHash = await entryPoint.read.getUserOpHash([unsigned]) as Hex;
    const op = { ...unsigned, signature: await sdk.signUserOperationHash(userOpHash) };
    const invalidSigner = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(publicClient.simulateContract({ address: entryPoint.address, abi: entryPoint.abi,
      functionName: "handleOps", args: [[{ ...op, signature: await invalidSigner.sign({ hash: userOpHash }) }], owner.account.address] }));
    const sent = await entryPoint.write.handleOps([[op], owner.account.address]);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: sent });
    const events = parseEventLogs({ abi: [userOperationEvent], logs: receipt.logs, eventName: "UserOperationEvent" });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.userOpHash, userOpHash);
    assert.equal(events[0].args.success, true);
    assert.equal(await target.read.calls(), 1n);
    assert.equal(await entryPoint.read.getNonce([agent, 0n]), 1n);
    await assert.rejects(publicClient.simulateContract({ address: entryPoint.address, abi: entryPoint.abi,
      functionName: "handleOps", args: [[op], owner.account.address] }));

    const usedNonces = new Set<string>();
    const sessions = new Map<Hex, Session>();
    const service = new AgenticWorld<{ id: string }>({
      client: publicClient,
      chainId: await publicClient.getChainId(),
      audience: "https://service-a.example",
      pinnedImplementation: await factory.read.implementation() as Address,
      requestNonces: { async consume(id, nonce) {
        const key = `${id.toLowerCase()}:${nonce.toLowerCase()}`;
        if (usedNonces.has(key)) return false;
        usedNonces.add(key);
        return true;
      } },
      sessions: { async put(hash, session) { sessions.set(hash, session); }, async get(hash) { return sessions.get(hash); } },
      association: { mode: "owner", async resolveUser(address) {
        return address.toLowerCase() === owner.account.address.toLowerCase() ? { id: "demo-user" } : null;
      } },
    });
    const request = { method: "GET", target: "/private/report", body: new Uint8Array() };
    const proof = await sdk.signRequest(request, "https://service-a.example");
    const authenticated = await service.authenticateRequest(proof, request);
    assert.equal(authenticated.user?.id, "demo-user");
    assert.equal(authenticated.session.agentId.toLowerCase(), agent.toLowerCase());
    assert.equal((await service.readSession(authenticated.token))?.user?.id, "demo-user");
    await assert.rejects(service.authenticateRequest(proof, request));
  });
});
