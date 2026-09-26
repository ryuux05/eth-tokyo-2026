import { createHash, randomBytes } from "node:crypto";
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
  const hashToken = (token: string) => `0x${createHash("sha256").update(token).digest("hex")}` as Hex;
  const ownerSession = async (request: IncomingMessage) => {
    const token = request.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("ServiceBOwner="))?.slice("ServiceBOwner=".length);
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const value = await options.stores.ownerSessions.get(hashToken(token));
    return value && value.expiresAt > Math.floor(Date.now() / 1000) ? value : undefined;
  };
  const reportFor = async (owner: Address) => {
    await options.stores.reports.initialize(owner, { text: `Your private Service B report code is ${randomBytes(6).toString("hex")}.`, updatedAt: new Date().toISOString() });
    const report = await options.stores.reports.get(owner);
    if (!report) throw new Error("Report unavailable");
    return report;
  };
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

  const reportAccess = (action: "read" | "write") => service.middleware({ realm: "Service B", authorize: async ({ session, user }) => {
    await options.stores.agents.discover(user.owner, { agentId: session.agentId, read: user.report, write: false });
    const permissions = await options.stores.agents.get(user.owner, session.agentId);
    const allowed = Boolean(user.report && permissions?.[action]);
    if (!allowed) await record("DENIED", `${action === "read" ? "Read" : "Write"} permission is off`, user.owner, session.agentId);
    return allowed;
  } });
  const requireRead = reportAccess("read"), requireWrite = reportAccess("write");

  return async (request: IncomingMessage, response: ServerResponse) => {
    if (request.headers.host !== new URL(baseUrl).host) {
      sendJson(response, 403, { error: "Use the configured Service B origin" });
      return;
    }
    const url = new URL(request.url ?? "/", baseUrl);
    const path = url.pathname;
    if (!["GET", "HEAD"].includes(request.method ?? "") && request.headers.origin && request.headers.origin !== baseUrl) {
      sendJson(response, 403, { error: "Cross-origin request denied" }); return;
    }
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
      const signedIn = await ownerSession(request);
      // Anonymous callers never receive owner identifiers, agent activity, or report text.
      sendJson(response, 200, { events: signedIn ? (await options.stores.events()).filter(event => event.owner?.toLowerCase() === signedIn.owner.toLowerCase()) : [] });
      return;
    }
    if (path === "/owner/workspace" || path === "/owner/permissions") {
      const signedIn = await ownerSession(request);
      if (!signedIn) { sendJson(response, 401, { error: "Sign in with your owner wallet to manage permissions" }); return; }
      if (path === "/owner/workspace" && request.method === "GET") {
        sendJson(response, 200, { owner: signedIn.owner, agents: await options.stores.agents.list(signedIn.owner), report: await reportFor(signedIn.owner) });
        return;
      }
      if (path === "/owner/permissions" && request.method === "POST") {
        try {
          const input = await readJson(request);
          if (typeof input.agentId !== "string" || !isAddress(input.agentId) || typeof input.read !== "boolean" || typeof input.write !== "boolean") throw new Error("Invalid permissions");
          const agentId = getAddress(input.agentId);
          // Only accounts previously associated by a verified SDK proof appear in this owner's map.
          if (!await options.stores.agents.get(signedIn.owner, agentId)) { sendJson(response, 403, { error: "This agent has not authenticated under your owner account" }); return; }
          await options.stores.agents.put(signedIn.owner, { agentId, read: input.read, write: input.write });
          await record("PERMISSIONS", `Read ${input.read ? "on" : "off"} · Write ${input.write ? "on" : "off"}`, signedIn.owner, agentId);
          sendJson(response, 200, { agentId, read: input.read, write: input.write });
        } catch { sendJson(response, 400, { error: "Could not save permissions. Check the values and retry." }); }
        return;
      }
      sendJson(response, 405, { error: "Unsupported method" }); return;
    }
    if (request.method === "GET" && path === "/owner/status") {
      const address = url.searchParams.get("address");
      if (!address || !isAddress(address)) { sendJson(response, 400, { error: "Valid wallet address required" }); return; }
      const entitlement = await owners.get(getAddress(address));
      sendJson(response, 200, { owner: getAddress(address), registered: Boolean(entitlement), report: entitlement?.report ?? false });
      return;
    }
    if (request.method === "POST" && path === "/owner/challenge") {
      try {
        const input = await readJson(request);
        if (typeof input.owner !== "string" || !isAddress(input.owner) || input.owner.toLowerCase() === zeroAddress) throw new Error("Valid wallet address required");
        const owner = getAddress(input.owner);
        const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        const message = `Sign in as ${owner} to Agentic World Service B\nOrigin: ${baseUrl}\nChain ID: ${options.chainId}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt * 1000).toISOString()}\n\nRegister this owner and authorize a one-hour browser session to view its report and manage agent read/write permissions. No blockchain transaction or spending approval.`;
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
        const token = randomBytes(32).toString("base64url");
        await options.stores.ownerSessions.put(hashToken(token), { owner: entitlement.owner, expiresAt: Math.floor(Date.now() / 1000) + 3600 });
        response.setHeader("Set-Cookie", `ServiceBOwner=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${baseUrl.startsWith("https:") ? "; Secure" : ""}`);
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
    if (path === "/private/report" && ["GET", "PUT"].includes(request.method ?? "")) {
      await (request.method === "PUT" ? requireWrite : requireRead)(request, response, async () => {
        const { session } = (request as AgenticRequest<Entitlement>).agentic!;
        if (request.method === "PUT") {
          let text: string;
          try {
            const input = await readJson(request);
            if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) throw new Error("Invalid text");
            text = input.text;
          } catch { sendJson(response, 400, { error: "Send JSON with text containing 1–2000 characters" }); return; }
          const updatedAt = new Date().toISOString();
          await options.stores.reports.put(session.owner!, { text, updatedAt, updatedBy: session.agentId });
          await record("UPDATED", "Agent updated the private text", session.owner, session.agentId)
            .catch(() => { console.error("Service B activity unavailable after report update"); });
          sendJson(response, 200, { updated: true, updatedAt }); // Write does not grant read access.
          return;
        }
        const report = await reportFor(session.owner!);
        await record("ALLOWED", "Report returned · 200", session.owner, session.agentId);
        sendJson(response, 200, { service: "Service B", resource: "report", agentId: session.agentId,
          owner: session.owner, result: report.text, text: report.text, updatedAt: report.updatedAt });
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
