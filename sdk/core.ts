import { type Address, type Hex } from "viem";
import { DELEGATION_PREFIX } from "./shared.js";

/** Shared, backend-free protocol definitions. Agent and service SDKs depend on this. */
export {
  ERC1271_MAGIC,
  DELEGATION_PREFIX,
  agentAccountAbi,
  mandateRegistryAbi,
  assertAddress,
  assertAudience,
  authenticationTypedData,
  authenticationDigest,
  encodeAuthenticationProof,
} from "./shared.js";
export type { AuthenticationChallenge, AuthenticationProof } from "./shared.js";
export {
  Decision,
  TOKEN_PURCHASE_SELECTOR,
  agentPolicyAbi,
  encodePolicy,
  decodePolicy,
  ownerActionTypedData,
} from "./policy.js";
export type { PolicyRule } from "./policy.js";

export function isExpectedDelegation(code: Hex | undefined, implementation: Address): boolean {
  return code?.toLowerCase() === `${DELEGATION_PREFIX}${implementation.slice(2)}`.toLowerCase();
}

export function agentInitializationTypedData(input: {
  agent: Address;
  owner: Address;
  authenticator: Address;
  chainId: number;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: {
      name: "Agentic World AgentAccount",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.agent,
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
    primaryType: "AgentInitialization" as const,
    message: {
      agent: input.agent,
      owner: input.owner,
      authenticator: input.authenticator,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}

export function agentRegistrationTypedData(input: {
  agent: Address;
  principal: Address;
  chainId: number;
  registry: Address;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: {
      name: "Agentic World Mandate Registry",
      version: "1",
      chainId: input.chainId,
      verifyingContract: input.registry,
    },
    types: {
      AgentRegistration: [
        { name: "agent", type: "address" },
        { name: "principal", type: "address" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "AgentRegistration" as const,
    message: {
      agent: input.agent,
      principal: input.principal,
      nonce: input.nonce,
      deadline: input.deadline,
    },
  } as const;
}
