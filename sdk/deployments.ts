import { isAddress, type Address } from "viem";

export const SEPOLIA_CHAIN_ID = 11155111;

/** Agentic World v0 deployment verified in Sepolia transaction 0xb9fe814993ba3cda718853d5648bda2dc38c5e687b2e8646a44bd7f92286c15c. */
export const LEGACY_SEPOLIA_DEPLOYMENT = Object.freeze({
  factory: "0x63f158897834bbc1579e82dfc29a7aacc8b91f93" as Address,
  implementation: "0xd08B955ca8727d86e708ae5684D5fa7f32635e66" as Address,
  validator: "0x8626C6788393632e7Cd07992B6E97E5B9c2eaF55" as Address,
  policyHook: "0x64C2685aDD03EBcaDf4b769B39f7979A1b3a5968" as Address,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address,
});

/** Execution stack verified against compiled factory initcode in transaction
 *  0x6041588b9ef0b0d83de192b19d6b11ff5a0e35231679439f43fa4fdfc6e42fa8, block 11788771. */
export const SEPOLIA_DEPLOYMENT = Object.freeze({
  factory: "0xf78336a75b7b517fdb784b1a34eae9527628b065" as Address,
  implementation: "0x43671979CAA5d8631Fdddbc01c59Ea005516F5Bd" as Address,
  validator: "0x6A9c4FA6B8a42B1c82B6d701cC76232633D243a0" as Address,
  policyHook: "0x72db3464519404302a95D65130b0a2fbE53E23d6" as Address,
  entryPoint: "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as Address,
});

function sameAddress(left: Address, right: Address): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** Current deployment by default. Services may explicitly retain the known
 *  legacy authentication pin; unknown implementations remain rejected. */
export function trustedImplementation(chainId: number, configured?: Address): Address {
  if (chainId === SEPOLIA_CHAIN_ID) {
    if (configured && sameAddress(configured, LEGACY_SEPOLIA_DEPLOYMENT.implementation)) return LEGACY_SEPOLIA_DEPLOYMENT.implementation;
    if (configured && !sameAddress(configured, SEPOLIA_DEPLOYMENT.implementation))
      throw new Error("Sepolia implementation differs from the Agentic World deployment");
    return SEPOLIA_DEPLOYMENT.implementation;
  }
  if (!configured || !isAddress(configured)) throw new Error("A trusted implementation is required for this chain");
  return configured;
}

export function trustedFactory(chainId: number, configured?: Address): Address | undefined {
  if (chainId === SEPOLIA_CHAIN_ID) {
    if (configured && sameAddress(configured, LEGACY_SEPOLIA_DEPLOYMENT.factory)) return LEGACY_SEPOLIA_DEPLOYMENT.factory;
    if (configured && !sameAddress(configured, SEPOLIA_DEPLOYMENT.factory))
      throw new Error("Sepolia factory differs from the Agentic World deployment");
    return SEPOLIA_DEPLOYMENT.factory;
  }
  if (configured && !isAddress(configured)) throw new Error("Invalid trusted factory address");
  return configured;
}
