import artifact from "../artifacts/contracts/demo/PolicyDemoService.sol/PolicyDemoService.json";
import type { Hex } from "viem";
import { createServiceCHandler } from "./handler.js";
import { deploymentStores } from "./stores.js";
import { createVerifiedSepoliaClient } from "../scripts/sepolia-runtime.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";

export function serviceCOrigin(environment: NodeJS.ProcessEnv): string {
  const value = environment.SERVICE_C_ORIGIN ?? (environment.VERCEL_URL ? `https://${environment.VERCEL_URL}` :
    environment.VERCEL ? undefined : "http://127.0.0.1:8807");
  if (!value) throw new Error("Configure SERVICE_C_ORIGIN");
  const origin = new URL(value);
  const local = !environment.VERCEL && origin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(origin.hostname);
  if ((!local && origin.protocol !== "https:") || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/")
    throw new Error("SERVICE_C_ORIGIN must be a canonical HTTPS origin (loopback HTTP only for local runs)");
  return origin.origin;
}

let initialized: Promise<Awaited<ReturnType<typeof createServiceCHandler>>> | undefined;
export function serviceCHandler() {
  initialized ??= (async () => {
    const origin = serviceCOrigin(process.env);
    const stores = deploymentStores(origin, process.env);
    const client = await createVerifiedSepoliaClient(process.env.AGENTIC_SEPOLIA_RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com");
    return createServiceCHandler({ client, chainId: SEPOLIA_CHAIN_ID, implementation: SEPOLIA_DEPLOYMENT.implementation,
      origin, audience: new URL(origin).protocol === "https:" ? origin : "https://service-c.example", stores,
      artifact: { bytecode: artifact.bytecode as Hex, deployedBytecode: artifact.deployedBytecode as Hex } });
  })().catch(error => { initialized = undefined; throw error; });
  return initialized;
}
