import { concatHex, encodeFunctionData, isAddress, toHex, zeroAddress, type Address, type Hex } from "viem";

export const AGENT_SINGLE_EXECUTION_MODE = `0x${"00".repeat(32)}` as Hex;

export const agent4337ExecutionAbi = [
  { type: "function", name: "execute", stateMutability: "payable", inputs: [
    { name: "mode", type: "bytes32" }, { name: "executionCalldata", type: "bytes" },
  ], outputs: [] },
  { type: "function", name: "executeWithApproval", stateMutability: "nonpayable", inputs: [
    { name: "mode", type: "bytes32" }, { name: "executionCalldata", type: "bytes" },
    { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint64" },
    { name: "signature", type: "bytes" },
  ], outputs: [] },
] as const;

export type OwnerApproval = { nonce: bigint; deadline: bigint; signature: Hex };

/** ERC-7579 single-call payload, wrapped in the account's ERC-4337 callData. */
export function encodeAgentExecution(target: Address, value: bigint, data: Hex, approval?: OwnerApproval): Hex {
  if (!isAddress(target) || target.toLowerCase() === zeroAddress) throw new Error("Invalid execution target");
  if (value < 0n || value > (1n << 256n) - 1n) throw new Error("Invalid execution value");
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error("Invalid execution data");
  const execution = concatHex([target, toHex(value, { size: 32 }), data]);
  return approval
    ? encodeFunctionData({ abi: agent4337ExecutionAbi, functionName: "executeWithApproval",
      args: [AGENT_SINGLE_EXECUTION_MODE, execution, approval.nonce, approval.deadline, approval.signature] })
    : encodeFunctionData({ abi: agent4337ExecutionAbi, functionName: "execute",
      args: [AGENT_SINGLE_EXECUTION_MODE, execution] });
}
