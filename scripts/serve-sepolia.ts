import { startDemoService } from "../demo-service/server.js";
import { startDemoServiceB } from "../demo-service-b/server.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";
import { createVerifiedSepoliaClient, resolveSepoliaRpcUrl } from "./sepolia-runtime.js";

function port(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) throw new Error("Service port must be an integer from 1 to 65535");
  return parsed;
}

const serviceAPort = port(process.env.AGENTIC_SERVICE_A_PORT, 8787);
const serviceBPort = port(process.env.AGENTIC_SERVICE_B_PORT, 8797);
if (serviceAPort === serviceBPort) throw new Error("Service A and B need different loopback ports");

const rpcUrl = await resolveSepoliaRpcUrl();
const client = await createVerifiedSepoliaClient(rpcUrl);
let serviceA: Awaited<ReturnType<typeof startDemoService>> | undefined;
let serviceB: Awaited<ReturnType<typeof startDemoServiceB>> | undefined;
try {
  serviceA = await startDemoService({ client, chainId: SEPOLIA_CHAIN_ID, implementation: SEPOLIA_DEPLOYMENT.implementation,
    audience: "https://service-a.example", port: serviceAPort });
  serviceB = await startDemoServiceB({ client, chainId: SEPOLIA_CHAIN_ID, implementation: SEPOLIA_DEPLOYMENT.implementation,
    audience: "https://service-b.example", port: serviceBPort });
} catch (error) {
  if (serviceA) await serviceA.close();
  throw error;
}

process.stdout.write(`AGENTIC WORLD SEPOLIA SERVICES READY\nService A (owner-signed manual enrollment): ${serviceA.baseUrl}\nService B (owner-derived association):      ${serviceB.baseUrl}\nService A operator key:                     ${serviceA.operatorToken}\nChain:                                      Sepolia (${SEPOLIA_CHAIN_ID})\nFactory:                                    ${SEPOLIA_DEPLOYMENT.factory}\nImplementation:                             ${SEPOLIA_DEPLOYMENT.implementation}\n`);
process.stdout.write("These HTTP services stay on 127.0.0.1; identity and ERC-1271 checks use Sepolia. Enrollment, permissions, and sessions are in memory and reset on restart.\n");

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await Promise.all([serviceA?.close(), serviceB?.close()]);
}
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
