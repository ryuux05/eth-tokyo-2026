import artifact from "../artifacts/contracts/demo/PolicyDemoService.sol/PolicyDemoService.json";
import type { Hex } from "viem";
import { createServiceCHandler } from "./handler.js";
import { deploymentStores } from "./stores.js";
import { createVerifiedSepoliaClient } from "../scripts/sepolia-runtime.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";
import { serviceCOrigin } from "./origin.js";
export { serviceCOrigin } from "./origin.js";

const initialized = new Map<string, Promise<Awaited<ReturnType<typeof createServiceCHandler>>>>();
export function serviceCHandler(requestHost?: string) {
  const origin = serviceCOrigin(process.env, requestHost);
  let handler = initialized.get(origin);
  if (handler) return handler;
  handler = (async () => {
    const stores = deploymentStores(origin, process.env);
    const client = await createVerifiedSepoliaClient(process.env.AGENTIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");
    return createServiceCHandler({ client, chainId: SEPOLIA_CHAIN_ID, implementation: SEPOLIA_DEPLOYMENT.implementation,
      origin, audience: new URL(origin).protocol === "https:" ? origin : "https://service-c.example", stores,
      artifact: { bytecode: artifact.bytecode as Hex, deployedBytecode: artifact.deployedBytecode as Hex } });
  })().catch(error => { initialized.delete(origin); throw error; });
  initialized.set(origin, handler);
  return handler;
}
