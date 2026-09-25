import assert from "node:assert/strict";
import { describe, it } from "node:test";
import hre from "hardhat";
import { encodeAbiParameters, hashTypedData, keccak256, toBytes } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createAgentSdk } from "../sdk/agent.js";
import { createServiceSdk, type ChallengeStore, type SessionStore } from "../sdk/service.js";
import type { AuthenticationChallenge } from "../sdk/shared.js";

const VALID = "0x1626ba7e";
const INVALID = "0xffffffff";

const authProofAbi = [
  {
    type: "tuple",
    components: [
      { name: "agentId", type: "address" },
      { name: "audienceHash", type: "bytes32" },
      { name: "nonce", type: "bytes32" },
      { name: "issuedAt", type: "uint64" },
      { name: "expiresAt", type: "uint64" },
      { name: "authenticatorSignature", type: "bytes" },
    ],
  },
] as const;

async function setup() {
  const { viem } = await hre.network.create();
  const [owner, stranger] = await viem.getWalletClients();
  const publicClient = await viem.getPublicClient();
  const agentRoot = privateKeyToAccount(generatePrivateKey());
  const authenticator = privateKeyToAccount(generatePrivateKey());
  const implementation = await viem.deployContract("AgentAccount");
  const registry = await viem.deployContract("MandateRegistry");
  const chainId = await publicClient.getChainId();

  const delegation = await owner.signAuthorization({
    account: agentRoot,
    contractAddress: implementation.address,
  });
  const delegationTx = await owner.sendTransaction({
    to: owner.account.address,
    value: 0n,
    authorizationList: [delegation],
  });
  await publicClient.waitForTransactionReceipt({ hash: delegationTx });

  const code = await publicClient.getCode({ address: agentRoot.address });
  assert.equal(code?.toLowerCase(), `0xef0100${implementation.address.slice(2).toLowerCase()}`);

  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const initialization = {
    agent: agentRoot.address,
    owner: owner.account.address,
    authenticator: authenticator.address,
    nonce: 0n,
    deadline,
  };
  const rootInitializationSignature = await agentRoot.signTypedData({
    domain: {
      name: "Agentic World AgentAccount",
      version: "1",
      chainId,
      verifyingContract: agentRoot.address,
    },
    types: {
      AgentInitialization: [
        { name: "agent", type: "address" },
        { name: "owner", type: "address" },
        { name: "authenticator", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "AgentInitialization",
    message: initialization,
  });

  return {
    owner,
    stranger,
    publicClient,
    agentRoot,
    authenticator,
    implementation,
    registry,
    chainId,
    deadline,
    rootInitializationSignature,
  };
}

async function initialize(context: Awaited<ReturnType<typeof setup>>) {
  const hash = await context.owner.writeContract({
    address: context.agentRoot.address,
    abi: context.implementation.abi,
    functionName: "initialize",
    args: [context.authenticator.address, 0n, context.deadline, context.rootInitializationSignature],
  });
  await context.publicClient.waitForTransactionReceipt({ hash });
}

async function authentication(
  context: Awaited<ReturnType<typeof setup>>,
  signer: ReturnType<typeof privateKeyToAccount>,
  audience: string,
) {
  const issuedAt = BigInt(Math.floor(Date.now() / 1000));
  const expiresAt = issuedAt + 60n;
  const message = {
    agentId: context.agentRoot.address,
    audienceHash: keccak256(toBytes(audience)),
    nonce: keccak256(toBytes("single-use-service-challenge")),
    issuedAt,
    expiresAt,
  };
  const typedData = {
    domain: {
      name: "Agentic World AgentAccount",
      version: "1",
      chainId: context.chainId,
      verifyingContract: context.agentRoot.address,
    },
    types: {
      AgentAuthentication: [
        { name: "agentId", type: "address" },
        { name: "audienceHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
      ],
    },
    primaryType: "AgentAuthentication" as const,
    message,
  };
  const digest = hashTypedData(typedData);
  const authenticatorSignature = await signer.signTypedData(typedData);
  const envelope = encodeAbiParameters(authProofAbi, [
    { ...message, authenticatorSignature },
  ]);
  return { digest, envelope };
}

describe("AgentAccount under EIP-7702", () => {
  it("requires both the owner transaction and an agent-root bootstrap permit", async () => {
    const context = await setup();

    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.stranger.account,
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "initialize",
        args: [
          context.authenticator.address,
          0n,
          context.deadline,
          context.rootInitializationSignature,
        ],
      }),
    );
    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.owner.account,
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "initialize",
        args: [context.authenticator.address, 0n, context.deadline, "0x1234"],
      }),
    );

    await initialize(context);
    assert.equal(
      String(await context.publicClient.readContract({
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "owner",
      })).toLowerCase(),
      context.owner.account.address.toLowerCase(),
    );

    await assert.rejects(
      context.publicClient.readContract({
        address: context.implementation.address,
        abi: context.implementation.abi,
        functionName: "owner",
      }),
    );

    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.owner.account,
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "initialize",
        args: [
          context.authenticator.address,
          0n,
          context.deadline,
          context.rootInitializationSignature,
        ],
      }),
    );
  });

  it("accepts only the current authenticator's structured authentication proof", async () => {
    const context = await setup();
    await initialize(context);
    const proof = await authentication(context, context.authenticator, "service-a.example");

    const check = async (digest: `0x${string}`, envelope: `0x${string}`) =>
      context.publicClient.readContract({
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "isValidSignature",
        args: [digest, envelope],
      });

    assert.equal(await check(proof.digest, proof.envelope), VALID);
    assert.equal(await check(keccak256(toBytes("wrong digest")), proof.envelope), INVALID);
    assert.equal(await check(proof.digest, "0x1234"), INVALID);

    const newAuthenticator = privateKeyToAccount(generatePrivateKey());
    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.stranger.account,
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "rotateAuthenticator",
        args: [newAuthenticator.address],
      }),
    );
    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.stranger.account,
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "revokeAuthenticator",
      }),
    );
    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.stranger.account,
        address: context.agentRoot.address,
        abi: context.implementation.abi,
        functionName: "restoreAuthenticator",
        args: [newAuthenticator.address],
      }),
    );

    const rotateTx = await context.owner.writeContract({
      address: context.agentRoot.address,
      abi: context.implementation.abi,
      functionName: "rotateAuthenticator",
      args: [newAuthenticator.address],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: rotateTx });
    assert.equal(await check(proof.digest, proof.envelope), INVALID);

    const newProof = await authentication(context, newAuthenticator, "service-a.example");
    assert.equal(await check(newProof.digest, newProof.envelope), VALID);

    const revokeTx = await context.owner.writeContract({
      address: context.agentRoot.address,
      abi: context.implementation.abi,
      functionName: "revokeAuthenticator",
    });
    await context.publicClient.waitForTransactionReceipt({ hash: revokeTx });
    assert.equal(await check(newProof.digest, newProof.envelope), INVALID);

    const restoreTx = await context.owner.writeContract({
      address: context.agentRoot.address,
      abi: context.implementation.abi,
      functionName: "restoreAuthenticator",
      args: [newAuthenticator.address],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: restoreTx });
    assert.equal(await check(newProof.digest, newProof.envelope), VALID);
  });
});

describe("MandateRegistry", () => {
  it("records msg.sender as principal and supports owner-only revocation", async () => {
    const context = await setup();
    await initialize(context);

    const rootPermit = await context.agentRoot.signTypedData({
      domain: {
        name: "Agentic World Mandate Registry",
        version: "1",
        chainId: context.chainId,
        verifyingContract: context.registry.address,
      },
      types: {
        AgentRegistration: [
          { name: "agent", type: "address" },
          { name: "principal", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint64" },
        ],
      },
      primaryType: "AgentRegistration",
      message: {
        agent: context.agentRoot.address,
        principal: context.owner.account.address,
        nonce: 0n,
        deadline: context.deadline,
      },
    });

    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.stranger.account,
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "register",
        args: [context.agentRoot.address, 0n, context.deadline, rootPermit],
      }),
    );

    const registrationTx = await context.owner.writeContract({
      address: context.registry.address,
      abi: context.registry.abi,
      functionName: "register",
      args: [context.agentRoot.address, 0n, context.deadline, rootPermit],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: registrationTx });
    assert.equal(
      String(await context.publicClient.readContract({
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "principalOf",
        args: [context.agentRoot.address],
      })).toLowerCase(),
      context.owner.account.address.toLowerCase(),
    );

    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.owner.account,
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "register",
        args: [context.agentRoot.address, 0n, context.deadline, rootPermit],
      }),
    );

    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.stranger.account,
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "revoke",
        args: [context.agentRoot.address],
      }),
    );

    const revokeTx = await context.owner.writeContract({
      address: context.registry.address,
      abi: context.registry.abi,
      functionName: "revoke",
      args: [context.agentRoot.address],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: revokeTx });
    assert.equal(
      await context.publicClient.readContract({
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "principalOf",
        args: [context.agentRoot.address],
      }),
      "0x0000000000000000000000000000000000000000",
    );
    assert.equal(
      await context.publicClient.readContract({
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "nonceOf",
        args: [context.agentRoot.address],
      }),
      2n,
    );

    await assert.rejects(
      context.publicClient.simulateContract({
        account: context.owner.account,
        address: context.registry.address,
        abi: context.registry.abi,
        functionName: "register",
        args: [context.agentRoot.address, 0n, context.deadline, rootPermit],
      }),
    );
  });
});

describe("Agent and service SDK interoperability", () => {
  it("authenticates independently, prevents replay, and exposes only an active mandate", async () => {
    const context = await setup();
    await initialize(context);
    let clock = Math.floor(Date.now() / 1000);
    const makeStores = () => {
      const challenges = new Map<string, AuthenticationChallenge>();
      const consumed = new Set<string>();
      const sessions = new Map<string, { agentId: `0x${string}`; principal?: `0x${string}`; expiresAt: number }>();
      const challengeStore: ChallengeStore = {
        async put(challenge) { challenges.set(challenge.nonce, challenge); },
        async get(nonce) { return consumed.has(nonce) ? undefined : challenges.get(nonce); },
        async consume(nonce) {
          if (consumed.has(nonce) || !challenges.has(nonce)) return false;
          consumed.add(nonce);
          return true;
        },
      };
      const sessionStore: SessionStore = {
        async put(hash, session) { sessions.set(hash, session); },
        async get(hash) { return sessions.get(hash); },
      };
      return { challengeStore, sessionStore };
    };
    const createService = (audience: string) => {
      const { challengeStore, sessionStore } = makeStores();
      return createServiceSdk({
        client: context.publicClient,
        chainId: context.chainId,
        audience,
        implementation: context.implementation.address,
        registry: context.registry.address,
        challenges: challengeStore,
        sessions: sessionStore,
        now: () => clock,
      });
    };
    const serviceA = createService("https://service-a.example");
    const serviceB = createService("https://service-b.example");
    const agent = createAgentSdk({
      agentId: context.agentRoot.address,
      chainId: context.chainId,
      signDigest: digest => context.authenticator.sign({ hash: digest }),
      now: () => clock,
    });

    const challengeA = await serviceA.issueChallenge(context.agentRoot.address);
    await assert.rejects(agent.answerChallenge(challengeA, "https://service-b.example"));
    const proofA = await agent.answerChallenge(challengeA, "https://service-a.example");
    await assert.rejects(serviceB.authenticate(proofA));
    const first = await serviceA.authenticate(proofA);
    assert.equal(first.session.agentId, context.agentRoot.address);
    assert.equal(first.session.principal, undefined);
    assert.deepEqual(await serviceA.readSession(first.token), first.session);
    await assert.rejects(serviceA.authenticate(proofA));

    const rootPermit = await context.agentRoot.signTypedData({
      domain: { name: "Agentic World Mandate Registry", version: "1", chainId: context.chainId, verifyingContract: context.registry.address },
      types: { AgentRegistration: [
        { name: "agent", type: "address" }, { name: "principal", type: "address" },
        { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
      ] },
      primaryType: "AgentRegistration",
      message: { agent: context.agentRoot.address, principal: context.owner.account.address, nonce: 0n, deadline: context.deadline },
    });
    const registrationTx = await context.owner.writeContract({
      address: context.registry.address, abi: context.registry.abi, functionName: "register",
      args: [context.agentRoot.address, 0n, context.deadline, rootPermit],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: registrationTx });

    const challengeB = await serviceB.issueChallenge(context.agentRoot.address);
    const proofB = await agent.answerChallenge(challengeB, "https://service-b.example");
    const second = await serviceB.authenticate(proofB);
    assert.equal(second.session.principal?.toLowerCase(), context.owner.account.address.toLowerCase());

    const revokeTx = await context.owner.writeContract({
      address: context.registry.address, abi: context.registry.abi, functionName: "revoke", args: [context.agentRoot.address],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: revokeTx });
    assert.equal(await serviceB.currentPrincipal(context.agentRoot.address), undefined);
    // An issued session is intentionally cached until its short local expiry.
    assert.deepEqual(await serviceB.readSession(second.token), second.session);

    const rotationChallenge = await serviceB.issueChallenge(context.agentRoot.address);
    const oldProof = await agent.answerChallenge(rotationChallenge, "https://service-b.example");
    const newAuthenticator = privateKeyToAccount(generatePrivateKey());
    const rotationTx = await context.owner.writeContract({
      address: context.agentRoot.address, abi: context.implementation.abi,
      functionName: "rotateAuthenticator", args: [newAuthenticator.address],
    });
    await context.publicClient.waitForTransactionReceipt({ hash: rotationTx });
    await assert.rejects(serviceB.authenticate(oldProof));
    const rotatedAgent = createAgentSdk({
      agentId: context.agentRoot.address,
      chainId: context.chainId,
      signDigest: digest => newAuthenticator.sign({ hash: digest }),
      now: () => clock,
    });
    const newProof = await rotatedAgent.answerChallenge(rotationChallenge, "https://service-b.example");
    const afterRotation = await serviceB.authenticate(newProof);
    assert.equal(afterRotation.session.principal, undefined);

    clock += 61;
    assert.equal(await serviceB.readSession(second.token), undefined);
  });
});
