import { keccak256, type Address, type Hex } from "viem";
import { randomBytes } from "node:crypto";
import {
  assertAudience,
  assertHttpRequest,
  authenticationDigest,
  requestAuthenticationDigest,
  type HttpRequest,
  type RequestAuthenticationProof,
  type AuthenticationChallenge,
  type AuthenticationProof,
} from "./core.js";

export type DigestSigner = (digest: Hex) => Promise<Hex>;

/** Attach these to the resource request that was signed. Never reuse them on a different request. */
export function requestProofHeaders(proof: RequestAuthenticationProof): Record<string, string> {
  return {
    "Agent-ID": proof.agentId,
    "Agent-Chain-ID": String(proof.chainId),
    "Agent-Nonce": proof.nonce,
    "Agent-Issued-At": String(proof.issuedAt),
    "Agent-Expires-At": String(proof.expiresAt),
    "Agent-Signature": proof.signature,
  };
}

export function createAgentSdk(config: {
  agentId: Address;
  chainId: number;
  signDigest: DigestSigner;
  now?: () => number;
  requestTtlSeconds?: number;
}) {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));
  const requestTtl = config.requestTtlSeconds ?? 60;
  if (!Number.isSafeInteger(requestTtl) || requestTtl < 1 || requestTtl > 300) throw new Error("Invalid request TTL");

  return {
    /** Sign the canonical hash returned by the configured ERC-4337 EntryPoint/bundler. */
    async signUserOperationHash(userOpHash: Hex): Promise<Hex> {
      if (!/^0x[0-9a-fA-F]{64}$/.test(userOpHash)) throw new Error("Invalid UserOperation hash");
      const signature = await config.signDigest(userOpHash);
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Signer returned an invalid ECDSA signature");
      return signature;
    },
    async signRequest(request: HttpRequest, expectedAudience: string): Promise<RequestAuthenticationProof> {
      assertAudience(expectedAudience);
      assertHttpRequest(request);
      const issuedAt = now();
      const unsigned = {
        agentId: config.agentId,
        audience: expectedAudience,
        chainId: config.chainId,
        nonce: `0x${randomBytes(32).toString("hex")}` as Hex,
        issuedAt,
        expiresAt: issuedAt + requestTtl,
        method: request.method,
        target: request.target,
        bodyHash: keccak256(request.body),
      };
      const signature = await config.signDigest(requestAuthenticationDigest(unsigned));
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Signer returned an invalid ECDSA signature");
      return { ...unsigned, signature };
    },
    async answerChallenge(challenge: AuthenticationChallenge, expectedAudience: string): Promise<AuthenticationProof> {
      assertAudience(expectedAudience);
      if (challenge.agentId.toLowerCase() !== config.agentId.toLowerCase()) throw new Error("Unexpected agent ID");
      if (challenge.chainId !== config.chainId) throw new Error("Unexpected chain ID");
      if (challenge.audience !== expectedAudience) throw new Error("Unexpected audience");
      if (!/^0x[0-9a-fA-F]{64}$/.test(challenge.nonce)) throw new Error("Invalid nonce");
      if (!Number.isSafeInteger(challenge.issuedAt) || !Number.isSafeInteger(challenge.expiresAt) || challenge.issuedAt > now() + 30 || challenge.expiresAt <= now() || challenge.expiresAt <= challenge.issuedAt) {
        throw new Error("Expired or invalid challenge");
      }
      const signature = await config.signDigest(authenticationDigest(challenge));
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Signer returned an invalid ECDSA signature");
      return { ...challenge, signature };
    },
  };
}

export type { AuthenticationChallenge, AuthenticationProof, RequestAuthenticationProof, HttpRequest, PolicyRule } from "./core.js";
export { Decision, TOKEN_PURCHASE_SELECTOR, agentPolicyAbi, decodePolicy, encodePolicy, ownerActionTypedData,
  AGENT_SINGLE_EXECUTION_MODE, agent4337ExecutionAbi, encodeAgentExecution } from "./core.js";
