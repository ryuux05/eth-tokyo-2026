import type { Address } from "viem";

export type Deployment = { implementation: Address; factory: Address };

/** Pin the v0 factory and its ERC-1167 implementation on each supported chain.
 *  Never accept either address from a URL parameter or an agent request.
 */
export const DEPLOYMENTS: Record<number, Deployment> = {
  11155111: {
    factory: "0x63f158897834bbc1579e82dfc29a7aacc8b91f93",
    implementation: "0xd08B955ca8727d86e708ae5684D5fa7f32635e66",
  },
};
