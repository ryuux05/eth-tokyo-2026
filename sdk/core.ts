import { type Address, type Hex } from "viem";
import { CLONE_PREFIX, CLONE_SUFFIX, DELEGATION_PREFIX } from "./shared.js";

/** Shared, backend-free protocol definitions. Agent and service SDKs depend on this. */
export {
  ERC1271_MAGIC,
  DELEGATION_PREFIX,
  CLONE_PREFIX,
  CLONE_SUFFIX,
  agentAccountAbi,
  agentAccountFactoryAbi,
  mandateRegistryAbi,
  assertAddress,
  assertAudience,
  authenticationTypedData,
  authenticationDigest,
  encodeAuthenticationProof,
  REQUEST_PROOF_PREFIX,
  assertHttpRequest,
  requestAuthenticationTypedData,
  requestAuthenticationDigest,
  encodeRequestAuthenticationProof,
} from "./shared.js";
export type { AuthenticationChallenge, AuthenticationProof, HttpRequest, RequestAuthentication, RequestAuthenticationProof } from "./shared.js";
export {
  Decision,
  TOKEN_PURCHASE_SELECTOR,
  agentPolicyAbi,
  encodePolicy,
  decodePolicy,
  ownerActionTypedData,
} from "./policy.js";
export type { PolicyRule } from "./policy.js";
export { AGENT_SINGLE_EXECUTION_MODE, agent4337ExecutionAbi, encodeAgentExecution } from "./execution.js";
export type { OwnerApproval } from "./execution.js";
export { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT, trustedFactory, trustedImplementation } from "./deployments.js";

export function isExpectedDelegation(code: Hex | undefined, implementation: Address): boolean {
  return code?.toLowerCase() === `${DELEGATION_PREFIX}${implementation.slice(2)}`.toLowerCase();
}

/** Exact ERC-1167 runtime used by the v0 factory; other proxy bytecode is rejected. */
export function isExpectedAgentClone(code: Hex | undefined, implementation: Address): boolean {
  return code?.toLowerCase() === `${CLONE_PREFIX}${implementation.slice(2)}${CLONE_SUFFIX}`.toLowerCase();
}

/** Preserve explicit EIP-7702 prototype support while accepting v0 smart-account clones. */
export function isExpectedAgentAccountCode(code: Hex | undefined, implementation: Address): boolean {
  return isExpectedAgentClone(code, implementation) || isExpectedDelegation(code, implementation);
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
