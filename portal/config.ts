import type { Address } from "viem";

export type Deployment = { implementation: Address; factory: Address };

/** Pin the v0 factory and its ERC-1167 implementation on each supported chain.
 *  Never accept either address from a URL parameter or an agent request.
 *  This project has no public deployment yet, so the map is intentionally empty.
 */
export const DEPLOYMENTS: Record<number, Deployment> = {};
