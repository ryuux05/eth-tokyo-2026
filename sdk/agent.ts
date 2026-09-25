import { type Address, type Hex } from "viem";
import {
  assertAudience,
  authenticationDigest,
  type AuthenticationChallenge,
  type AuthenticationProof,
} from "./shared.js";

export type DigestSigner = (digest: Hex) => Promise<Hex>;

export function createAgentSdk(config: {
  agentId: Address;
  chainId: number;
  signDigest: DigestSigner;
  now?: () => number;
}) {
  const now = config.now ?? (() => Math.floor(Date.now() / 1000));

  return {
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

export type { AuthenticationChallenge, AuthenticationProof } from "./shared.js";
export { Decision, TOKEN_PURCHASE_SELECTOR, agentPolicyAbi, decodePolicy, encodePolicy, ownerActionTypedData } from "./policy.js";
export type { PolicyRule } from "./policy.js";
