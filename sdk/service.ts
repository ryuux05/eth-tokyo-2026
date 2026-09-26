import { createHash, randomBytes } from "node:crypto";
import { keccak256, type Address, type Hex, type PublicClient, zeroAddress } from "viem";
import {
  agentAccountAbi,
  assertAddress,
  assertAudience,
  assertHttpRequest,
  authenticationDigest,
  encodeAuthenticationProof,
  encodeRequestAuthenticationProof,
  ERC1271_MAGIC,
  isExpectedAgentAccountCode,
  mandateRegistryAbi,
  requestAuthenticationDigest,
  type HttpRequest,
  type RequestAuthenticationProof,
  type AuthenticationChallenge,
  type AuthenticationProof,
} from "./core.js";

export type Session = {
  agentId: Address;
  /** Read from the pinned AgentAccount at the authentication block, in owner mode. */
  owner?: Address;
  /** Legacy optional registry association; not used by AgenticWorld modes. */
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

export interface RequestNonceStore {
  /** Atomic insert-if-absent, keyed by agent and nonce; retain at least through expiresAt. */
  consume(agentId: Address, nonce: Hex, expiresAt: number): Promise<boolean>;
}

/** Parse only proof fields from headers; method, target and body come from the actual HTTP request. */
export function requestProofFromHeaders(
  headers: Record<string, string | string[] | undefined>,
  request: HttpRequest,
  audience: string,
): RequestAuthenticationProof {
  assertAudience(audience);
  assertHttpRequest(request);
  const header = (name: string): string => {
    const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1 || typeof matches[0]?.[1] !== "string") throw new Error(`Missing or repeated ${name} header`);
    return matches[0][1];
  };
  const integer = (name: string): number => {
    const value = header(name);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`Invalid ${name} header`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw new Error(`Invalid ${name} header`);
    return parsed;
  };
  const agentId = header("Agent-ID");
  assertAddress(agentId);
  return {
    agentId,
    audience,
    chainId: integer("Agent-Chain-ID"),
    nonce: header("Agent-Nonce") as Hex,
    issuedAt: integer("Agent-Issued-At"),
    expiresAt: integer("Agent-Expires-At"),
    method: request.method,
    target: request.target,
    bodyHash: keccak256(request.body),
    signature: header("Agent-Signature") as Hex,
  };
}

export type ServiceSdkConfig = {
  client: PublicClient;
  chainId: number;
  audience: string;
  implementation: Address;
  /** Read owner() at the same block as the ERC-1271 check. */
  readOwner?: boolean;
  registry?: Address;
  challenges?: ChallengeStore;
  sessions: SessionStore;
  requestNonces?: RequestNonceStore;
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
  // Snapshot the trusted implementation. V0 checks the exact factory clone
  // runtime; the earlier EIP-7702 pointer remains supported for old deployments.
  config = Object.freeze({ ...config });
  assertAudience(config.audience);
  assertAddress(config.implementation);
  if (config.registry) assertAddress(config.registry);
  if (!config.requestNonces && !config.challenges) throw new Error("Configure a request nonce store or challenge store");
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
    // Authentication must not reuse viem's cached chain head after key revocation.
    const blockNumber = await config.client.getBlockNumber({ cacheTime: 0 });
    const code = await config.client.getCode({ address: agentId, blockNumber });
    if (!isExpectedAgentAccountCode(code, config.implementation)) throw new Error("Unexpected agent account implementation");
    const owner = config.readOwner || config.registry
      ? await config.client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "owner", blockNumber })
      : undefined;
    if (config.readOwner && (!owner || sameAddress(owner, zeroAddress))) throw new Error("Uninitialized agent owner");
    if (!config.registry) return { blockNumber, owner, principal: undefined };
    const principal = await config.client.readContract({ address: config.registry, abi: mandateRegistryAbi, functionName: "principalOf", args: [agentId], blockNumber });
    return { blockNumber, owner, principal: owner && !sameAddress(principal, zeroAddress) && sameAddress(principal, owner) ? principal : undefined };
  }

  return {
    /** Verify a proof attached to the first resource request; no challenge round trip. */
    async authenticateRequest(proof: RequestAuthenticationProof, request: HttpRequest): Promise<{ token: string; session: Session }> {
      if (!config.requestNonces) throw new Error("Request nonce store is not configured");
      assertHttpRequest(request);
      if (!/^0x[0-9a-fA-F]{64}$/.test(proof.nonce) || !/^0x[0-9a-fA-F]{64}$/.test(proof.bodyHash) || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(proof.signature)) throw new Error("Malformed request proof");
      if (proof.audience !== config.audience || proof.chainId !== config.chainId || proof.method !== request.method || proof.target !== request.target || proof.bodyHash.toLowerCase() !== keccak256(request.body).toLowerCase()) {
        throw new Error("Request proof does not match this HTTP request");
      }
      const timestamp = now();
      if (!Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt) || proof.issuedAt > timestamp + 30 || proof.expiresAt <= timestamp || proof.expiresAt <= proof.issuedAt || proof.expiresAt - proof.issuedAt > 300) {
        throw new Error("Request proof is expired or invalid");
      }
      const { blockNumber, owner, principal } = await checkAgent(proof.agentId);
      const result = await config.client.readContract({
        address: proof.agentId,
        abi: agentAccountAbi,
        functionName: "isValidSignature",
        args: [requestAuthenticationDigest(proof), encodeRequestAuthenticationProof(proof)],
        blockNumber,
      });
      if (result.toLowerCase() !== ERC1271_MAGIC) throw new Error("Invalid agent request signature");
      if (!(await config.requestNonces.consume(proof.agentId, proof.nonce, proof.expiresAt))) throw new Error("Request nonce already consumed");
      const token = randomBytes(32).toString("base64url");
      const session: Session = { agentId: proof.agentId, ...(config.readOwner && owner ? { owner } : {}), ...(principal ? { principal } : {}), expiresAt: now() + sessionTtl };
      await config.sessions.put(tokenHash(token), session);
      return { token, session };
    },
    async issueChallenge(agentId: Address): Promise<AuthenticationChallenge> {
      if (!config.challenges) throw new Error("Challenge store is not configured");
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
      if (!config.challenges) throw new Error("Challenge store is not configured");
      if (!/^0x[0-9a-fA-F]{64}$/.test(proof.nonce) || !/^0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130})$/.test(proof.signature)) throw new Error("Malformed proof");
      const challenge = await config.challenges.get(proof.nonce);
      if (!challenge || !sameChallenge(proof, challenge)) throw new Error("Unknown or mismatched challenge");
      const timestamp = now();
      if (challenge.audience !== config.audience || challenge.chainId !== config.chainId || !Number.isSafeInteger(proof.issuedAt) || !Number.isSafeInteger(proof.expiresAt) || proof.issuedAt > timestamp + 30 || proof.expiresAt <= timestamp) {
        throw new Error("Challenge expired or not valid for this service");
      }
      const { blockNumber, owner, principal } = await checkAgent(challenge.agentId);
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
      const session: Session = { agentId: challenge.agentId, ...(config.readOwner && owner ? { owner } : {}), ...(principal ? { principal } : {}), expiresAt: now() + sessionTtl };
      await config.sessions.put(tokenHash(token), session);
      return { token, session };
    },

    async readSession(token: string): Promise<Session | undefined> {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
      const session = await config.sessions.get(tokenHash(token));
      return session && session.expiresAt > now() ? session : undefined;
    },

    /** Fresh optional owner-binding check for routes requiring immediate revocation. */
    async currentPrincipal(agentId: Address): Promise<Address | undefined> {
      return (await checkAgent(agentId)).principal;
    },
  };
}

export type Association<User> =
  | {
      mode: "manual";
      /** Service-owned enrollment: a logged-in human explicitly added this agent. */
      resolveUser: (agentId: Address) => Promise<User | null | undefined>;
    }
  | {
      mode: "owner";
      /** Service-owned wallet lookup after owner() is read from the pinned agent account. */
      resolveUser: (owner: Address) => Promise<User | null | undefined>;
    };

export type AgenticWorldConfig<User> = Omit<ServiceSdkConfig, "implementation" | "readOwner" | "registry"> & {
  /** Trusted deployment address, supplied at service startup; never from an agent request. */
  pinnedImplementation: Address;
  association: Association<User>;
};

/** Service-facing authentication layer. Association lookup never grants a resource by itself. */
export class AgenticWorld<User> {
  private readonly association: Association<User>;
  private readonly service: ReturnType<typeof createServiceSdk>;

  constructor(config: AgenticWorldConfig<User>) {
    const { association, pinnedImplementation, ...serviceConfig } = config;
    this.association = Object.freeze({ ...association });
    this.service = createServiceSdk({
      ...serviceConfig,
      implementation: pinnedImplementation,
      readOwner: association.mode === "owner",
    });
  }

  private async userFor(session: Session): Promise<User | null> {
    if (this.association.mode === "manual") {
      return (await this.association.resolveUser(session.agentId)) ?? null;
    }
    if (!session.owner) throw new Error("Authenticated session has no owner");
    return (await this.association.resolveUser(session.owner)) ?? null;
  }

  async authenticateRequest(proof: RequestAuthenticationProof, request: HttpRequest) {
    const result = await this.service.authenticateRequest(proof, request);
    return { ...result, user: await this.userFor(result.session) };
  }

  async issueChallenge(agentId: Address) {
    return this.service.issueChallenge(agentId);
  }

  async authenticate(proof: AuthenticationProof) {
    const result = await this.service.authenticate(proof);
    return { ...result, user: await this.userFor(result.session) };
  }

  async readSession(token: string) {
    const session = await this.service.readSession(token);
    return session ? { session, user: await this.userFor(session) } : undefined;
  }
}

export type { AuthenticationChallenge, AuthenticationProof, HttpRequest, RequestAuthenticationProof } from "./core.js";
