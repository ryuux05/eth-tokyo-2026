import { encodeFunctionData, isAddress, maxUint256, parseUnits, zeroAddress, type Address, type Hex } from "viem";
import { Decision, encodePolicy, TOKEN_PURCHASE_SELECTOR } from "../sdk/policy.js";

export const SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" as Address;
export const USDC_DECIMALS = 6;
export const purchaseAbi = [{ type: "function", name: "purchaseCompute", stateMutability: "nonpayable",
  inputs: [{ name: "token", type: "address" }, { name: "amount", type: "uint256" }], outputs: [] }] as const;

/** Do not let parseUnits silently round amounts with more than six decimal places. */
export function parseUsdc(value: string): bigint {
  if (!/^(0|[1-9][0-9]{0,70})(\.[0-9]{1,6})?$/.test(value)) throw new Error("Enter a positive USDC amount with at most six decimal places");
  const amount = parseUnits(value, USDC_DECIMALS);
  if (amount <= 0n || amount > maxUint256) throw new Error("USDC amount is out of range");
  return amount;
}

/** This replaces the entire policy. It grants no ERC-20 allowance and no arbitrary calls. */
export function serviceCPolicy(target: Address, token: Address, threshold = 5_000_000n): Hex {
  if (!isAddress(token) || token.toLowerCase() === zeroAddress) throw new Error("Invalid USDC token");
  if (threshold <= 0n || threshold >= maxUint256) throw new Error("Invalid automatic-payment threshold");
  const rule = { target, selector: TOKEN_PURCHASE_SELECTOR, token, maxValue: 0n };
  return encodePolicy([
    { ...rule, maxAmount: threshold, decision: Decision.ALLOW },
    { ...rule, maxAmount: maxUint256, decision: Decision.REQUIRE_OWNER_SIGNATURE },
  ]);
}

export function purchaseData(token: Address, amount: bigint): Hex {
  return encodeFunctionData({ abi: purchaseAbi, functionName: "purchaseCompute", args: [token, amount] });
}
