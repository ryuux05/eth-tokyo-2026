import { createHash, randomBytes } from "node:crypto";
import { type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import {
  agentAccountAbi,
  assertAddress,
  assertAudience,
  authenticationDigest,
  encodeAuthenticationProof,
  ERC1271_MAGIC,
  isExpectedDelegation,
  mandateRegistryAbi,
  type AuthenticationChallenge,
  type AuthenticationProof,
} from "./core.js";

export type Session = {
  agentId: Address;
  principal?: Address;
  expiresAt: number;
};

export interface ChallengeStore {
  put(challenge: AuthenticationChallenge): Promise<void>;
  get(nonce: Hex): Promise<AuthenticationChallenge | undefined>;
  /** Must atomically return false if this nonce was already consumed. */
  consume(nonce: Hex): Promise<boolean>;
}

export interface SessionStore {
  put(tokenHash: Hex, session: Session): Promise<void>;
  get(tokenHash: Hex): Promise<Session | undefined>;
}

export type ServiceSdkConfig = {
  client: PublicClient;
  chainId: number;
  audience: string;
  implementation: Address;
  registry: Address;
  challenges: ChallengeStore;
  sessions: SessionStore;
  challengeTtlSeconds?: number;
  sessionTtlSeconds?: number;
  now?: () => number;
};

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function tokenHash(token: string): Hex {
  return `0x${createHash("sha256").update(token).digest("hex")}`;
}

function sameChallenge(a: AuthenticationChallenge, b: AuthenticationChallenge): boolean {
  return sameAddress(a.agentId, b.agentId) && a.audience === b.audience && a.chainId === b.chainId && a.nonce === b.nonce && a.issuedAt === b.issuedAt && a.expiresAt === b.expiresAt;
}

export function createServiceSdk(config: ServiceSdkConfig) {
  assertAudience(config.audience);
  assertAddress(config.implementation);
  assertAddress(config.registry);
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error("Invalid chain ID");
  const challengeTtl = config.challengeTtlSeconds ?? 60;
  const sessionTtl = config.sessionTtlSeconds ?? 60;
  if (!Number.isSafeInteger(challengeTtl) || challengeTtl < 1 || challengeTtl > 300 || !Number.isSafeInteger(sessionTtl) || sessionTtl < 1 || sessionTtl > 300) {
    throw new Error("TTL must be between 1 and 300 seconds");
  }
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  async function checkAgent(agentId: Address) {
    assertAddress(agentId);
    if (sameAddress(agentId, zeroAddress)) throw new Error("Zero agent ID");
    if (await config.client.getChainId() !== config.chainId) throw new Error("RPC chain ID mismatch");
    const blockNumber = await config.client.getBlockNumber();
    const code = await config.client.getCode({ address: agentId, blockNumber });
    if (!isExpectedDelegation(code, config.implementation)) throw new Error("Unexpected EIP-7702 delegation");
    const owner = await config.client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "owner", blockNumber });
    const principal = await config.client.readContract({ address: config.registry, abi: mandateRegistryAbi, functionName: "principalOf", args: [agentId], blockNumber });
    return { blockNumber, principal: !sameAddress(principal, zeroAddress) && sameAddress(principal, owner) ? principal : undefined };
  }

  return {
    async issueChallenge(agentId: Address): Promise<AuthenticationChallenge> {
      await checkAgent(agentId);
      const issuedAt = now();
      const challenge: AuthenticationChallenge = {
        agentId,
        audience: config.audience,
        chainId: config.chainId,
        nonce: `0x${randomBytes(32).toString("hex")}`,
        issuedAt,
        expiresAt: issuedAt + challengeTtl,
      };
      await config.challenges.put(challenge);
      return challenge;
    },

    async authenticate(proof: AuthenticationProof): Promise<{ token: string; session: Session }> {
      if (!/^0x[0-9a-fA-F]{64}$/.test(proof.nonce) || !/^0x[0-9a-fA-F]{130}$/.test(proof.signature)) throw new Error("Malformed proof");
      const challenge = await config.challenges.get(proof.nonce);
      if (!challenge || !sameChallenge(proof, challenge)) throw new Error("Unknown or mismatched challenge");
      const timestamp = now();
      if (challenge.audience !== config.audience || challenge.chainId !== config.chainId || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt) || proof.issuedAt > timestamp + 30 || proof.expiresAt <= timestamp) {
        throw new Error("Challenge expired or not valid for this service");
      }
      const { blockNumber, principal } = await checkAgent(challenge.agentId);
      const result = await config.client.readContract({
        address: challenge.agentId,
        abi: agentAccountAbi,
        functionName: "isValidSignature",
        args: [authenticationDigest(challenge), encodeAuthenticationProof(proof)],
        blockNumber,
      });
      if (result.toLowerCase() !== ERC1271_MAGIC) throw new Error("Invalid agent signature");
      if (!(await config.challenges.consume(challenge.nonce))) throw new Error("Challenge already consumed");
      const token = randomBytes(32).toString("base64url");
      const session: Session = { agentId: challenge.agentId, ...(principal ? { principal } : {}), expiresAt: now() + sessionTtl };
      await config.sessions.put(tokenHash(token), session);
      return { token, session };
    },

    async readSession(token: string): Promise<Session | undefined> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      const session = await config.sessions.get(tokenHash(token));
      return session && session.expiresAt > now() ? session : undefined;
    },

    /** Fresh onchain mandate check for routes requiring immediate revocation. */
    async currentPrincipal(agentId: Address): Promise<Address | undefined> {
      return (await checkAgent(agentId)).principal;
    },
  };
}

export type { AuthenticationChallenge, AuthenticationProof } from "./core.js";
