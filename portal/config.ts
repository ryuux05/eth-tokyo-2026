import type { Address } from "viem";

export type Deployment = { implementation: Address; registry: Address };

/** Pin audited deployment addresses here before using the owner portal.
 *  Never accept an implementation address supplied by an agent or URL parameter.
 *  This project has no public deployment yet, so the map is intentionally empty.
 */
export const DEPLOYMENTS: Record<number, Deployment> = {};
