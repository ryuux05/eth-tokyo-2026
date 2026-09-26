import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, verifyMessage, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { AgenticWorld, type AgenticRequest } from "../sdk/service.js";
import { memoryServiceBStores, type Entitlement, type ServiceBStores } from "./stores.js";
import { agentAccountAbi, isExpectedAgentClone } from "../sdk/core.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";
import { createVerifiedSepoliaClient, resolveSepoliaRpcUrl } from "../scripts/sepolia-runtime.js";

type Options = {
  client: PublicClient;
  chainId: number;
  implementation: Address;
  audience: string;
  host?: string;
  port?: number;
  stores?: ServiceBStores;
};

function sendJson(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Use application/json");
  const parts: Buffer[] = [];
  let length = 0;
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
    length += bytes.length;
    if (length > 8192) throw new Error("Request body exceeds 8 KiB");
    parts.push(bytes);
  }
  const value: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a JSON object");
  return value as Record<string, unknown>;
}

/** Same SDK authentication handler for local HTTP and hosted functions. */
export function createServiceBHandler(options: Options & { origin: string; stores: ServiceBStores }) {
  const baseUrl = new URL(options.origin).origin;
  const { owners, wallets: walletChallenges, challenges, sessions } = options.stores;
  const record = (kind: string, detail: string, owner?: Address, agentId?: Address) =>
    options.stores.record({ at: new Date().toISOString(), kind, detail, ...(owner ? { owner } : {}), ...(agentId ? { agentId } : {}) });
  const service = new AgenticWorld<Entitlement>({
    client: options.client,
    chainId: options.chainId,
    audience: options.audience,
    pinnedImplementation: options.implementation,
    association: { mode: "owner", resolveUser: async owner => await owners.get(owner) ?? null },
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 300,
    challenges,
    sessions,
  });

  const requireReport = service.middleware({ realm: "Service B", authorize: async ({ session, user }) => {
    if (!user.report) await record("DENIED", "Report permission is not active", session.owner, session.agentId);
    return user.report;
  } });

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== new URL(baseUrl).host) {
      sendJson(response, 403, { error: "Use the configured Service B origin" });
      return;
    }
    const url = new URL(request.url ?? "/", baseUrl);
    const path = url.pathname;
    if (request.method === "GET" && ["/", "/app.js", "/styles.css"].includes(path)) {
      const name = path === "/" ? "index.html" : path.slice(1);
      const contentType = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
      try {
        const body = await readFile(fileURLToPath(new URL(`./dist/${name}`, import.meta.url)));
        response.writeHead(200, { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(body);
      } catch { sendJson(response, 500, { error: "Build the Service B page first" }); }
      return;
    }
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { service: "Service B", chainId: options.chainId, audience: options.audience,
        implementation: options.implementation, association: "owner", sessionTtlSeconds: 300 });
      return;
    }
    if (request.method === "GET" && path === "/activity") {
      sendJson(response, 200, { events: await options.stores.events() });
      return;
    }
    if (request.method === "GET" && path === "/owner/status") {
      const address = url.searchParams.get("address");
      if (!address || !isAddress(address)) { sendJson(response, 400, { error: "Valid wallet address required" }); return; }
      const entitlement = await owners.get(getAddress(address));
      sendJson(response, 200, { owner: getAddress(address), registered: Boolean(entitlement), report: entitlement?.report ?? false });
      return;
    }
    if (request.method === "POST" && request.headers.origin && request.headers.origin !== baseUrl) {
      sendJson(response, 403, { error: "Cross-origin request denied" });
      return;
    }
    if (request.method === "POST" && path === "/owner/challenge") {
      try {
        const input = await readJson(request);
        if (typeof input.owner !== "string" || !isAddress(input.owner) || input.owner.toLowerCase() === zeroAddress) throw new Error("Valid wallet address required");
        const owner = getAddress(input.owner);
        const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        const message = `Register ${owner} with Agentic World Service B\nOrigin: ${baseUrl}\nChain ID: ${options.chainId}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt * 1000).toISOString()}\n\nThis proves wallet control. It is not a blockchain transaction.`;
        await walletChallenges.put({ owner, nonce, message, expiresAt });
        sendJson(response, 200, { owner, nonce, message, expiresAt });
      } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not create challenge" }); }
      return;
    }
    if (request.method === "POST" && path === "/owner/register") {
      try {
        const input = await readJson(request);
        if (typeof input.owner !== "string" || !isAddress(input.owner) || typeof input.nonce !== "string" ||
            !/^0x[0-9a-fA-F]{64}$/.test(input.nonce) || typeof input.signature !== "string" ||
            !/^0x[0-9a-fA-F]{130}$/.test(input.signature)) throw new Error("Invalid wallet registration proof");
        const challenge = await walletChallenges.get(input.nonce as Hex);
        if (!challenge || challenge.owner.toLowerCase() !== input.owner.toLowerCase() || challenge.expiresAt <= Math.floor(Date.now() / 1000)) {
          throw new Error("Wallet challenge missing, expired, or mismatched");
        }
        const valid = await verifyMessage({ address: challenge.owner, message: challenge.message, signature: input.signature as Hex });
        if (!valid) throw new Error("Wallet signature did not match the registered address");
        if (!await walletChallenges.consume(challenge.nonce)) throw new Error("Wallet proof already used");
        const entitlement = await owners.get(challenge.owner) ?? { owner: challenge.owner, report: true };
        await owners.put(entitlement);
        await record("WALLET_REGISTERED", "Report entitlement is active", challenge.owner);
        sendJson(response, 200, { owner: entitlement.owner, registered: true, report: entitlement.report });
      } catch (error) { sendJson(response, 401, { error: error instanceof Error ? error.message : "Wallet registration failed" }); }
      return;
    }
    if (request.method === "POST" && path === "/agent/lookup") {
      try {
        const input = await readJson(request);
        if (typeof input.agentId !== "string" || !isAddress(input.agentId)) throw new Error("Valid agent address required");
        const agentId = getAddress(input.agentId);
        if (await options.client.getChainId() !== options.chainId) throw new Error("RPC chain mismatch");
        const blockNumber = await options.client.getBlockNumber({ cacheTime: 0 });
        const code = await options.client.getCode({ address: agentId, blockNumber });
        if (!isExpectedAgentClone(code, options.implementation)) throw new Error("Not an Agentic World account from the pinned implementation");
        const owner = await options.client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "owner", blockNumber });
        if (owner === zeroAddress) throw new Error("Agent account is not initialized");
        const entitlement = await owners.get(owner);
        sendJson(response, 200, { agentId, owner, ownerRegistered: Boolean(entitlement), report: entitlement?.report ?? false });
      } catch { sendJson(response, 400, { error: "Could not inspect agent. Check its address and Sepolia RPC availability." }); }
      return;
    }
    if (request.method === "GET" && path === "/private/report") {
      await requireReport(request, response, async () => {
        const { session } = (request as AgenticRequest<Entitlement>).agentic!;
        await record("ALLOWED", "Report returned · 200", session.owner, session.agentId);
        sendJson(response, 200, { service: "Service B", resource: "report", agentId: session.agentId,
          owner: session.owner, result: "Owner-associated private report available" });
      });
      if (response.statusCode === 401) await record("AUTH_REQUIRED", "Report request without a valid Agent-Session");
      return;
    }
    sendJson(response, 404, { error: "Unknown route" });
  };
}

/** Loopback adapter; hosted deployments supply Redis instead of per-process memory. */
export async function startDemoServiceB(options: Options) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("Service B may only bind to 127.0.0.1");
  let handler: ReturnType<typeof createServiceBHandler>;
  const server = createServer((request, response) => {
    void handler(request, response).catch(() => {
      if (!response.headersSent) sendJson(response, 503, { error: "Service B temporarily unavailable" });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8797, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service B did not bind");
  const baseUrl = `http://${host}:${address.port}`;
  handler = createServiceBHandler({ ...options, origin: baseUrl, stores: options.stores ?? memoryServiceBStores() });
  return { baseUrl, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const client = await createVerifiedSepoliaClient(await resolveSepoliaRpcUrl());
  const running = await startDemoServiceB({ client, chainId: SEPOLIA_CHAIN_ID, implementation: SEPOLIA_DEPLOYMENT.implementation,
    audience: "https://service-b.example", port: Number(process.env.AGENTIC_SERVICE_B_PORT ?? "8797") });
  process.stdout.write(`SERVICE_B_READY ${JSON.stringify({ url: running.baseUrl, audience: "https://service-b.example",
    chainId: SEPOLIA_CHAIN_ID, factory: SEPOLIA_DEPLOYMENT.factory })}\n`);
}
