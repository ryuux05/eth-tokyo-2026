import {
  encodeAbiParameters,
  hashTypedData,
  isAddress,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from "viem";

export const ERC1271_MAGIC = "0x1626ba7e";
export const DELEGATION_PREFIX = "0xef0100";

export type AuthenticationChallenge = {
  agentId: Address;
  audience: string;
  chainId: number;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
};

export type AuthenticationProof = AuthenticationChallenge & {
  signature: Hex;
};

export const agentAccountAbi = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "protocolVersion", stateMutability: "pure", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] },
] as const;

export const mandateRegistryAbi = [
  { type: "function", name: "principalOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
] as const;

const authProofAbi = [{
  type: "tuple",
  components: [
    { name: "agentId", type: "address" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "authenticatorSignature", type: "bytes" },
  ],
}] as const;

export function assertAddress(address: string): asserts address is Address {
  if (!isAddress(address)) throw new Error("Invalid agent address");
}

export function assertAudience(audience: string): void {
  // The protocol uses an exact HTTPS origin. URL parsing normalizes DNS casing,
  // default ports and IDNs; noncanonical spellings are rejected on the wire.
  const url = new URL(audience);
  if (url.protocol !== "https:" || url.origin !== audience || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Audience must be a canonical HTTPS origin");
  }
}

export function authenticationTypedData(challenge: AuthenticationChallenge) {
  return {
    domain: {
      name: "Agentic World AgentAccount",
      version: "1",
      chainId: challenge.chainId,
      verifyingContract: challenge.agentId,
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
    message: {
      agentId: challenge.agentId,
      audienceHash: keccak256(toBytes(challenge.audience)),
      nonce: challenge.nonce,
      issuedAt: BigInt(challenge.issuedAt),
      expiresAt: BigInt(challenge.expiresAt),
    },
  } as const;
}

export function authenticationDigest(challenge: AuthenticationChallenge): Hex {
  return hashTypedData(authenticationTypedData(challenge));
}

export function encodeAuthenticationProof(proof: AuthenticationProof): Hex {
  return encodeAbiParameters(authProofAbi, [{
    ...authenticationTypedData(proof).message,
    authenticatorSignature: proof.signature,
  }]);
}
