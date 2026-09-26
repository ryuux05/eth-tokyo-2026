import {
  concatHex,
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
export const CLONE_PREFIX = "0x363d3d373d3d3d363d73";
export const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";
export const REQUEST_PROOF_PREFIX = "0x41575231";

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

/** The HTTP origin-form target includes the path and raw query, but no fragment. */
export type HttpRequest = { method: string; target: string; body: Uint8Array };

export type RequestAuthentication = {
  agentId: Address;
  audience: string;
  chainId: number;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  method: string;
  target: string;
  bodyHash: Hex;
};

export type RequestAuthenticationProof = RequestAuthentication & { signature: Hex };

export const agentAccountAbi = [
  { type: "function", name: "supportsInterface", stateMutability: "pure", inputs: [{ name: "interfaceId", type: "bytes4" }], outputs: [{ type: "bool" }] },
  // Compatibility initializer for the historical EIP-7702 prototype. V0 clones
  // are initialized atomically by AgentAccountFactory.createAgentP256.
  { type: "function", name: "initialize", stateMutability: "nonpayable", inputs: [
    { name: "initialAuthenticator", type: "address" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" }, { name: "rootSignature", type: "bytes" },
  ], outputs: [] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "authenticator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "authenticatorScheme", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "authenticatorP256", stateMutability: "view", inputs: [], outputs: [{ name: "qx", type: "bytes32" }, { name: "qy", type: "bytes32" }] },
  { type: "function", name: "createdAt", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "authenticationRevoked", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "protocolVersion", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "agentValidator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "entryPoint", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "isModuleInstalled", stateMutability: "view", inputs: [
    { name: "moduleTypeId", type: "uint256" }, { name: "module", type: "address" },
    { name: "additionalContext", type: "bytes" },
  ], outputs: [{ type: "bool" }] },
  { type: "function", name: "rotateAuthenticator", stateMutability: "nonpayable", inputs: [{ name: "newAuthenticator", type: "address" }], outputs: [] },
  { type: "function", name: "rotateP256Authenticator", stateMutability: "nonpayable", inputs: [{ name: "qx", type: "bytes32" }, { name: "qy", type: "bytes32" }], outputs: [] },
  { type: "function", name: "revokeAuthenticator", stateMutability: "nonpayable", inputs: [], outputs: [] },
  { type: "function", name: "restoreAuthenticator", stateMutability: "nonpayable", inputs: [{ name: "newAuthenticator", type: "address" }], outputs: [] },
  { type: "function", name: "restoreP256Authenticator", stateMutability: "nonpayable", inputs: [{ name: "qx", type: "bytes32" }, { name: "qy", type: "bytes32" }], outputs: [] },
  { type: "function", name: "isValidSignature", stateMutability: "view", inputs: [{ type: "bytes32" }, { type: "bytes" }], outputs: [{ type: "bytes4" }] },
] as const;

export const agentAccountFactoryAbi = [
  { type: "function", name: "implementation", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "validator", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "policyHook", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "predictAgent", stateMutability: "view", inputs: [
    { name: "humanOwner", type: "address" }, { name: "salt", type: "bytes32" },
  ], outputs: [{ type: "address" }] },
  { type: "function", name: "createAgent", stateMutability: "nonpayable", inputs: [
    { name: "authenticator", type: "address" }, { name: "salt", type: "bytes32" },
  ], outputs: [{ type: "address" }] },
  { type: "function", name: "createAgentP256", stateMutability: "nonpayable", inputs: [
    { name: "qx", type: "bytes32" }, { name: "qy", type: "bytes32" }, { name: "salt", type: "bytes32" },
  ], outputs: [{ type: "address" }] },
] as const;

export const mandateRegistryAbi = [
  { type: "function", name: "principalOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "address" }] },
  { type: "function", name: "nonceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "register", stateMutability: "nonpayable", inputs: [
    { name: "agent", type: "address" }, { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" }, { name: "agentRootSignature", type: "bytes" },
  ], outputs: [] },
  { type: "function", name: "revoke", stateMutability: "nonpayable", inputs: [{ name: "agent", type: "address" }], outputs: [] },
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

const requestProofAbi = [{
  type: "tuple",
  components: [
    { name: "agentId", type: "address" },
    { name: "audienceHash", type: "bytes32" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "methodHash", type: "bytes32" },
    { name: "targetHash", type: "bytes32" },
    { name: "bodyHash", type: "bytes32" },
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

export function assertHttpRequest(request: HttpRequest): void {
  if (!/^[A-Z]+$/.test(request.method)) throw new Error("HTTP method must be uppercase ASCII");
  if (!request.target.startsWith("/") || request.target.startsWith("//") || /[\s#]/.test(request.target)) {
    throw new Error("Request target must be an exact origin-form path and query");
  }
  if (!(request.body instanceof Uint8Array)) throw new Error("Request body must be raw bytes");
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

export function requestAuthenticationTypedData(request: RequestAuthentication) {
  assertAudience(request.audience);
  assertHttpRequest({ method: request.method, target: request.target, body: new Uint8Array() });
  if (!/^0x[0-9a-fA-F]{64}$/.test(request.bodyHash)) throw new Error("Invalid body hash");
  return {
    domain: {
      name: "Agentic World AgentAccount",
      version: "1",
      chainId: request.chainId,
      verifyingContract: request.agentId,
    },
    types: {
      AgentRequest: [
        { name: "agentId", type: "address" },
        { name: "audienceHash", type: "bytes32" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint64" },
        { name: "expiresAt", type: "uint64" },
        { name: "methodHash", type: "bytes32" },
        { name: "targetHash", type: "bytes32" },
        { name: "bodyHash", type: "bytes32" },
      ],
    },
    primaryType: "AgentRequest" as const,
    message: {
      agentId: request.agentId,
      audienceHash: keccak256(toBytes(request.audience)),
      nonce: request.nonce,
      issuedAt: BigInt(request.issuedAt),
      expiresAt: BigInt(request.expiresAt),
      methodHash: keccak256(toBytes(request.method)),
      targetHash: keccak256(toBytes(request.target)),
      bodyHash: request.bodyHash,
    },
  } as const;
}

export function requestAuthenticationDigest(request: RequestAuthentication): Hex {
  return hashTypedData(requestAuthenticationTypedData(request));
}

export function encodeRequestAuthenticationProof(proof: RequestAuthenticationProof): Hex {
  return concatHex([REQUEST_PROOF_PREFIX, encodeAbiParameters(requestProofAbi, [{
    ...requestAuthenticationTypedData(proof).message,
    authenticatorSignature: proof.signature,
  }])]);
}
