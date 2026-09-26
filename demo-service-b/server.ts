import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, verifyMessage, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { AgenticWorld, type AuthenticationChallenge, type AuthenticationProof, type Session } from "../sdk/service.js";
import { agentAccountAbi, isExpectedAgentClone } from "../sdk/core.js";

type Entitlement = { owner: Address; report: boolean };
type WalletChallenge = { owner: Address; nonce: Hex; message: string; expiresAt: number };
type Event = { at: string; kind: string; agentId?: Address; owner?: Address; detail: string };
type Options = {
  client: PublicClient;
  chainId: number;
  implementation: Address;
  audience: string;
  host?: string;
  port?: number;
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

/** Owner-based association demo. All state is intentionally in memory and loopback-only. */
export async function startDemoServiceB(options: Options) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("Service B may only bind to 127.0.0.1");
  const owners = new Map<string, Entitlement>();
  const walletChallenges = new Map<Hex, WalletChallenge>();
  const challenges = new Map<Hex, AuthenticationChallenge>();
  const sessions = new Map<Hex, Session>();
  const events: Event[] = [];
  const record = (kind: string, detail: string, owner?: Address, agentId?: Address) => {
    events.unshift({ at: new Date().toISOString(), kind, detail, ...(owner ? { owner } : {}), ...(agentId ? { agentId } : {}) });
    if (events.length > 60) events.length = 60;
  };
  const service = new AgenticWorld<Entitlement>({
    client: options.client,
    chainId: options.chainId,
    audience: options.audience,
    pinnedImplementation: options.implementation,
    association: { mode: "owner", resolveUser: async owner => owners.get(owner.toLowerCase()) ?? null },
    challengeTtlSeconds: 300,
    sessionTtlSeconds: 300,
    challenges: {
      async put(challenge) { challenges.set(challenge.nonce, challenge); },
      async get(nonce) {
        const challenge = challenges.get(nonce);
        if (challenge && challenge.expiresAt <= Math.floor(Date.now() / 1000)) challenges.delete(nonce);
        return challenges.get(nonce);
      },
      async consume(nonce) { return challenges.delete(nonce); },
    },
    sessions: {
      async put(hash, session) { sessions.set(hash, session); },
      async get(hash) {
        const session = sessions.get(hash);
        if (session && session.expiresAt <= Math.floor(Date.now() / 1000)) sessions.delete(hash);
        return sessions.get(hash);
      },
    },
  });

  let baseUrl = "";
  const server = createServer(async (request, response) => {
    if (request.headers.host !== baseUrl.slice("http://".length)) {
      sendJson(response, 403, { error: "Use the loopback Service B URL shown at startup" });
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
      sendJson(response, 200, { events });
      return;
    }
    if (request.method === "GET" && path === "/owner/status") {
      const address = url.searchParams.get("address");
      if (!address || !isAddress(address)) { sendJson(response, 400, { error: "Valid wallet address required" }); return; }
      const entitlement = owners.get(address.toLowerCase());
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
        if (typeof input.owner !== "string" || !isAddress(input.owner)) throw new Error("Valid wallet address required");
        const owner = getAddress(input.owner);
        const nonce = `0x${randomBytes(32).toString("hex")}` as Hex;
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        const message = `Register ${owner} with Agentic World Service B\nOrigin: ${baseUrl}\nChain ID: ${options.chainId}\nNonce: ${nonce}\nExpires: ${new Date(expiresAt * 1000).toISOString()}\n\nThis proves wallet control. It is not a blockchain transaction.`;
        walletChallenges.set(nonce, { owner, nonce, message, expiresAt });
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
        const challenge = walletChallenges.get(input.nonce as Hex);
        if (!challenge || challenge.owner.toLowerCase() !== input.owner.toLowerCase() || challenge.expiresAt <= Math.floor(Date.now() / 1000)) {
          throw new Error("Wallet challenge missing, expired, or mismatched");
        }
        walletChallenges.delete(challenge.nonce);
        const valid = await verifyMessage({ address: challenge.owner, message: challenge.message, signature: input.signature as Hex });
        if (!valid) throw new Error("Wallet signature did not match the registered address");
        const entitlement = owners.get(challenge.owner.toLowerCase()) ?? { owner: challenge.owner, report: true };
        owners.set(challenge.owner.toLowerCase(), entitlement);
        record("WALLET_REGISTERED", "Report entitlement is active", challenge.owner);
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
        sendJson(response, 200, { agentId, owner, ownerRegistered: owners.has(owner.toLowerCase()),
          report: owners.get(owner.toLowerCase())?.report ?? false });
      } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Could not inspect agent" }); }
      return;
    }
    if (request.method === "POST" && path === "/agent/challenge") {
      try {
        const input = await readJson(request);
        if (typeof input.agentId !== "string" || !isAddress(input.agentId)) throw new Error("Invalid agent ID");
        const challenge = await service.createChallenge(input.agentId);
        record("AGENT_CHALLENGE", "Service-issued challenge", undefined, challenge.agentId);
        sendJson(response, 200, challenge);
      } catch { sendJson(response, 401, { error: "Could not issue an agent challenge" }); }
      return;
    }
    if (request.method === "POST" && path === "/agent/session") {
      try {
        const proof = await readJson(request);
        const result = await service.authenticate(proof as unknown as AuthenticationProof);
        record("AGENT_SESSION", "ERC-1271 proof accepted; owner is registered", result.session.owner, result.session.agentId);
        sendJson(response, 200, { agentId: result.session.agentId, owner: result.session.owner, expiresAt: result.session.expiresAt },
          { "Agent-Session": result.token });
      } catch { sendJson(response, 401, { error: "Agent proof rejected or owner wallet is not registered" }); }
      return;
    }
    if (request.method === "GET" && path === "/private/report") {
      const token = request.headers["agent-session"];
      let authenticated;
      try { authenticated = typeof token === "string" ? await service.readSession(token) : undefined; }
      catch { sendJson(response, 503, { error: "Could not validate this service session" }); return; }
      if (!authenticated) {
        record("AUTH_REQUIRED", "Report request without a valid Agent-Session");
        sendJson(response, 401, { error: "A valid Agent-Session is required" });
        return;
      }
      if (!authenticated.user?.report) {
        record("DENIED", "Report permission is not active", authenticated.session.owner, authenticated.session.agentId);
        sendJson(response, 403, { error: "This wallet has no report entitlement" });
        return;
      }
      record("ALLOWED", "Report returned · 200", authenticated.session.owner, authenticated.session.agentId);
      sendJson(response, 200, { service: "Service B", resource: "report", agentId: authenticated.session.agentId,
        owner: authenticated.session.owner, result: "Owner-associated private report available" });
      return;
    }
    sendJson(response, 404, { error: "Unknown route" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8797, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Service B did not bind");
  baseUrl = `http://${host}:${address.port}`;
  return { baseUrl, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
