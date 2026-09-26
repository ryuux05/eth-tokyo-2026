import type { Address } from "viem";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";

export type Deployment = { implementation: Address; factory: Address };

/** Pin the v0 factory and its ERC-1167 implementation on each supported chain.
 *  Never accept either address from a URL parameter or an agent request.
 */
export const DEPLOYMENTS: Record<number, Deployment> = {
  [SEPOLIA_CHAIN_ID]: SEPOLIA_DEPLOYMENT,
};
