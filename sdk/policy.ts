import { encodeAbiParameters, isAddress, keccak256, zeroAddress, type Address, type Hex } from "viem";

export const Decision = {
  DENY: 0,
  ALLOW: 1,
  REQUIRE_OWNER_SIGNATURE: 2,
} as const;

export type Decision = (typeof Decision)[keyof typeof Decision];

export type PolicyRule = {
  target: Address;
  selector: Hex;
  maxValue: bigint;
  decision: Decision;
};

/** Minimal ABI for owner dashboard and agent execution integrations. Call at 0xAGENT. */
export const agentPolicyAbi = [
  { type: "function", name: "setPolicy", stateMutability: "nonpayable", inputs: [{ name: "newPolicy", type: "bytes" }], outputs: [] },
  { type: "function", name: "policy", stateMutability: "view", inputs: [], outputs: [{ type: "bytes" }] },
  { type: "function", name: "policyHash", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "policyRevision", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ownerApprovalNonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "evaluateAction", stateMutability: "view", inputs: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
  ], outputs: [{ type: "uint8" }] },
  { type: "function", name: "execute", stateMutability: "nonpayable", inputs: [
    { name: "target", type: "address" }, { name: "value", type: "uint256" }, { name: "data", type: "bytes" },
    { name: "approval", type: "tuple", components: [
      { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" }, { name: "signature", type: "bytes" },
    ] },
  ], outputs: [{ type: "bytes" }] },
] as const;

const policyAbi = [
  { type: "uint8" },
  { type: "tuple[]", components: [
    { name: "target", type: "address" },
    { name: "selector", type: "bytes4" },
    { name: "maxValue", type: "uint256" },
    { name: "decision", type: "uint8" },
  ] },
] as const;

/** Rule order is significant: the first matching rule wins. No match means DENY. */
export function encodePolicy(rules: readonly PolicyRule[]): Hex {
  if (rules.length > 32) throw new Error("Policy exceeds 32 rules");
  for (const rule of rules) {
    if (!isAddress(rule.target) || rule.target.toLowerCase() === zeroAddress) throw new Error("Invalid policy target");
    if (!/^0x[0-9a-fA-F]{8}$/.test(rule.selector)) throw new Error("Selector must be four bytes");
    if (rule.maxValue < 0n || rule.maxValue > (1n << 256n) - 1n) throw new Error("Invalid maximum value");
    if (rule.decision !== Decision.DENY && rule.decision !== Decision.ALLOW && rule.decision !== Decision.REQUIRE_OWNER_SIGNATURE) throw new Error("Invalid decision");
  }
  const encoded = encodeAbiParameters(policyAbi, [1, [...rules]]);
  if ((encoded.length - 2) / 2 > 8192) throw new Error("Policy exceeds 8192 bytes");
  return encoded;
}

export function ownerActionTypedData(action: {
  agent: Address;
  chainId: number;
  target: Address;
  value: bigint;
  data: Hex;
  policyHash: Hex;
  policyRevision: bigint;
  nonce: bigint;
  deadline: bigint;
}) {
  return {
    domain: {
      name: "Agentic World AgentAccount",
      version: "1",
      chainId: action.chainId,
      verifyingContract: action.agent,
    },
    types: {
      OwnerActionApproval: [
        { name: "agent", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "target", type: "address" },
        { name: "value", type: "uint256" },
        { name: "dataHash", type: "bytes32" },
        { name: "policyHash", type: "bytes32" },
        { name: "policyRevision", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
    },
    primaryType: "OwnerActionApproval" as const,
    message: {
      agent: action.agent,
      chainId: BigInt(action.chainId),
      target: action.target,
      value: action.value,
      dataHash: keccak256(action.data),
      policyHash: action.policyHash,
      policyRevision: action.policyRevision,
      nonce: action.nonce,
      deadline: action.deadline,
    },
  } as const;
}
