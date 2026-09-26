import type { IncomingMessage, ServerResponse } from "node:http";
import { getAddress, isAddress, parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { agentAccountAbi, isExpectedAgentClone } from "../sdk/core.js";
import { agentPolicyAbi } from "../sdk/policy.js";
import { AgenticWorld, type AgenticRequest } from "../sdk/service.js";
import { SEPOLIA_CHAIN_ID } from "../sdk/deployments.js";
import { parseUsdc, purchaseData, SEPOLIA_USDC } from "./policy.js";

import type { ServiceCStores } from "./stores.js";
export type Options = { client: PublicClient; chainId: number; implementation: Address; token?: Address;
  origin: string; audience: string; stores: ServiceCStores; artifact: { bytecode: Hex; deployedBytecode: Hex } };
const tokenAbi = parseAbi(["function decimals() view returns (uint8)"]);
const decisionNames = ["DENY", "ALLOW", "REQUIRE_OWNER_SIGNATURE"] as const;

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "x-frame-options": "DENY" });
  response.end(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}
function address(value: string | null): Address {
  if (!value || !isAddress(value) || value.toLowerCase() === zeroAddress) throw new Error("Enter a valid nonzero address");
  return getAddress(value);
}

/** Policy decision workbench. There are deliberately no broadcast, payment or signing APIs. */
export async function createServiceCHandler(options: Options) {
  const token = options.token ?? SEPOLIA_USDC;
  if (await options.client.getChainId() !== options.chainId) throw new Error("Service C RPC chain mismatch");
  if (options.chainId === SEPOLIA_CHAIN_ID && token.toLowerCase() !== SEPOLIA_USDC.toLowerCase()) throw new Error("Service C pins Sepolia USDC");
  if (await options.client.readContract({ address: token, abi: tokenAbi, functionName: "decimals" }) !== 6)
    throw new Error("Service C requires a six-decimal token");
  const artifact = options.artifact;
  const service = new AgenticWorld<{ owner: Address }>({
    client: options.client, chainId: options.chainId, pinnedImplementation: options.implementation,
    audience: options.audience,
    // Every verified agent can read its own policy. No paid service entitlement is implied.
    association: { mode: "owner", async resolveUser(owner) { return { owner }; } },
    challenges: options.stores.challenges,
    sessions: options.stores.sessions,
  });
  const authenticate = service.middleware({ realm: "Service C", authorize: () => true });

  async function inspect(agentId: Address, target: Address, amount: string, source: string) {
    const units = parseUsdc(amount);
    if (await options.client.getChainId() !== options.chainId) throw new Error("RPC chain mismatch");
    // An uncached head, and a single block for all reads: policy changes are visible on the next request.
    const blockNumber = await options.client.getBlockNumber({ cacheTime: 0 });
    const [agentCode, targetCode] = await Promise.all([
      options.client.getCode({ address: agentId, blockNumber }), options.client.getCode({ address: target, blockNumber }),
    ]);
    if (!isExpectedAgentClone(agentCode, options.implementation)) throw new Error("Not an agent from the pinned implementation");
    if (targetCode?.toLowerCase() !== artifact.deployedBytecode.toLowerCase())
      throw new Error("Target is not the Service C demo contract. Deploy it from this page or enter its existing address.");
    const read = { address: agentId, blockNumber };
    const [owner, revoked, policy, policyHash, policyRevision, decision] = await Promise.all([
      options.client.readContract({ ...read, abi: agentAccountAbi, functionName: "owner" }),
      options.client.readContract({ ...read, abi: agentAccountAbi, functionName: "authenticationRevoked" }),
      options.client.readContract({ ...read, abi: agentPolicyAbi, functionName: "policy" }),
      options.client.readContract({ ...read, abi: agentPolicyAbi, functionName: "policyHash" }),
      options.client.readContract({ ...read, abi: agentPolicyAbi, functionName: "policyRevision" }),
      options.client.readContract({ ...read, abi: agentPolicyAbi, functionName: "evaluateAction", args: [target, 0n, purchaseData(token, units)] }),
    ]);
    if (owner === zeroAddress || !decisionNames[decision]) throw new Error("Invalid agent policy state");
    const result = { agentId, owner, revoked, target, token, chainId: options.chainId, blockNumber: blockNumber.toString(),
      amount, amountBaseUnits: units.toString(), policy, policyHash, policyRevision: policyRevision.toString(),
      decision: decisionNames[decision], executionSubmitted: false,
      note: "Policy decision only. Does not check allowance, balance, gas, or guarantee execution. A revoked authenticator cannot execute even if policy says ALLOW." };
    await options.stores.record({ at: new Date().toISOString(), agentId, target, amount, decision: result.decision, blockNumber: result.blockNumber,
      policyRevision: result.policyRevision, source });
    return result;
  }

  const baseUrl = options.origin;
  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== new URL(baseUrl).host || (request.headers.origin && request.headers.origin !== baseUrl)) {
      json(response, 403, { error: "Use the configured Service C origin" }); return;
    }
    const url = new URL(request.url ?? "/", baseUrl);
    url.pathname = url.pathname.replace(/^\/api\//, "/");
    if (request.method !== "GET") { json(response, 405, { error: "Read-only service; wallet transactions happen in your browser" }); return; }
    try {
      if (url.pathname === "/health" || url.pathname === "/config") {
        json(response, 200, { service: "Service C", chainId: options.chainId, token, decimals: 6, audience: options.audience,
          implementation: options.implementation, mode: "policy-preview", deploymentBytecode: artifact.bytecode });
      } else if (url.pathname === "/activity") {
        json(response, 200, { events: await options.stores.events() });
      } else if (url.pathname === "/policy/preview") {
        json(response, 200, await inspect(address(url.searchParams.get("agentId")), address(url.searchParams.get("target")),
          url.searchParams.get("amount") ?? "5", "browser"));
      } else if (url.pathname === "/private/quote") {
        await authenticate(request, response, async () => {
          const { session } = (request as AgenticRequest<{ owner: Address }>).agentic!;
          json(response, 200, await inspect(session.agentId, address(url.searchParams.get("target")), url.searchParams.get("amount") ?? "5", "agent"));
        });
      } else if (url.pathname === "/transaction") {
        const hash = url.searchParams.get("hash");
        if (!hash || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Invalid transaction hash");
        // Wallet-submitted hashes only. A pending receipt must never cause a second send.
        const receipt = await options.client.getTransactionReceipt({ hash: hash as Hex }).catch(error => {
          if (error.name === "TransactionReceiptNotFoundError") return null;
          throw error;
        });
        json(response, 200, receipt ? { status: receipt.status, contractAddress: receipt.contractAddress, blockNumber: receipt.blockNumber.toString() } : { status: "pending" });
      } else json(response, 404, { error: "Unknown route" });
    } catch (error) { if (!response.headersSent) json(response, 400, { error: "Policy check failed. Check agent, target, amount and RPC availability." }); }
  };
}

