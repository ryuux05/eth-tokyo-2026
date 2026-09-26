import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress, recoverMessageAddress, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { AgenticWorld, type AgenticRequest, type AuthenticationChallenge, type Session } from "../sdk/service.js";
import { agentAccountAbi, isExpectedAgentClone } from "../sdk/core.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";
import { createVerifiedSepoliaClient, resolveSepoliaRpcUrl } from "../scripts/sepolia-runtime.js";

type Permission = "report" | "compute";
type Enrollment = {
  agentId: Address;
  owner: Address;
  scheme: "P-256" | "secp256k1";
  permissions: Record<Permission, boolean>;
};
type Event = { at: string; kind: string; agentId: Address; detail: string };
type Options = {
  client: PublicClient;
  chainId: number;
  implementation: Address;
  audience: string;
  operatorToken?: string;
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

function equalToken(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual); const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A loopback-only, intentionally in-memory example of service-owned authorization. */
export async function startDemoService(options: Options) {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") throw new Error("The demo service may only bind to 127.0.0.1");
  const operatorToken = options.operatorToken ?? randomBytes(24).toString("base64url");
  const enrollments = new Map<string, Enrollment>();
  const enrollmentChallenges = new Map<string, { agentId: Address; message: string; expiresAt: number }>();
  const challenges = new Map<Hex, AuthenticationChallenge>();
  const sessions = new Map<Hex, Session>();
  const events: Event[] = [];
  const record = (kind: string, agentId: Address, detail: string) => {
    events.unshift({ at: new Date().toISOString(), kind, agentId, detail });
    if (events.length > 40) events.length = 40;
  };
  const service = new AgenticWorld<Enrollment>({
    client: options.client,
    chainId: options.chainId,
    audience: options.audience,
    pinnedImplementation: options.implementation,
    association: { mode: "manual", resolveUser: async agentId => enrollments.get(agentId.toLowerCase()) ?? null },
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

  const requireResource = (resource: Permission) => service.middleware({ realm: "Service A", authorize: ({ session, user }) => {
    const allowed = user.permissions[resource];
    if (!allowed) record("DENIED", session.agentId, `${resource} · 403`);
    return allowed;
  } });
  const protectedResources = { report: requireResource("report"), compute: requireResource("compute") };

  let baseUrl = "";
  const server = createServer(async (request, response) => {
    if (request.headers.host !== baseUrl.slice("http://".length)) {
      sendJson(response, 403, { error: "Use the loopback service URL shown at startup" });
      return;
    }
    const path = new URL(request.url ?? "/", baseUrl).pathname;
    if (request.method === "GET" && ["/", "/app.js", "/styles.css"].includes(path)) {
      const name = path === "/" ? "index.html" : path.slice(1);
      const contentType = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
      try {
        const body = await readFile(fileURLToPath(new URL(`./dist/${name}`, import.meta.url)));
        response.writeHead(200, { "content-type": `${contentType}; charset=utf-8`, "cache-control": "no-store", "x-content-type-options": "nosniff" }).end(body);
      } catch { sendJson(response, 500, { error: "Build the demo-service page first" }); }
      return;
    }
    if (request.method === "GET" && path === "/health") {
      sendJson(response, 200, { service: "Service A", chainId: options.chainId, audience: options.audience,
        implementation: options.implementation, association: "manual", challengeTtlSeconds: 300, sessionTtlSeconds: 300 });
      return;
    }

    if (path.startsWith("/admin/")) {
      const origin = request.headers.origin;
      if (origin && origin !== baseUrl) { sendJson(response, 403, { error: "Cross-origin operator request denied" }); return; }
      if (!equalToken(request.headers["x-operator-token"], operatorToken)) {
        sendJson(response, 401, { error: "Enter the operator key printed by the local service" }); return;
      }
      if (request.method === "GET" && path === "/admin/state") {
        sendJson(response, 200, { enrollments: [...enrollments.values()], events });
        return;
      }
      if (request.method === "POST" && path === "/admin/permission") {
        try {
          const input = await readJson(request);
          if (typeof input.agentId !== "string" || !isAddress(input.agentId) ||
              (input.resource !== "report" && input.resource !== "compute") || typeof input.allowed !== "boolean") {
            throw new Error("Expected agentId, resource (report or compute), and allowed (boolean)");
          }
          const enrollment = enrollments.get(input.agentId.toLowerCase());
          if (!enrollment) { sendJson(response, 404, { error: "Enroll this agent first" }); return; }
          enrollment.permissions[input.resource] = input.allowed;
          record(input.allowed ? "GRANTED" : "REVOKED", enrollment.agentId, `${input.resource} access`);
          sendJson(response, 200, enrollment);
        } catch (error) { sendJson(response, 400, { error: error instanceof Error ? error.message : "Permission update failed" }); }
        return;
      }
      sendJson(response, 404, { error: "Unknown operator endpoint" });
      return;
    }

    if (request.method === "POST" && path === "/user/enrollment-challenge") {
      try {
        const input = await readJson(request);
        if (typeof input.agentId !== "string" || !isAddress(input.agentId)) throw new Error("Enter a valid agent address");
        const agentId = getAddress(input.agentId);
        const nonce = `0x${randomBytes(32).toString("hex")}`;
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        const message = `Agentic World · Service A enrollment\nService: ${baseUrl}\nChain ID: ${options.chainId}\nAgent ID: ${agentId}\nNonce: ${nonce}\nExpires at: ${expiresAt}\n\nSign to add this agent to your Service A account. This does not grant resource permissions.`;
        enrollmentChallenges.set(nonce, { agentId, message, expiresAt });
        sendJson(response, 200, { agentId, nonce, message, expiresAt });
      } catch { sendJson(response, 400, { error: "Invalid agent ID" }); }
      return;
    }
    if (request.method === "POST" && path === "/user/enroll") {
      try {
        const input = await readJson(request);
        if (typeof input.agentId !== "string" || !isAddress(input.agentId) || typeof input.nonce !== "string" ||
            typeof input.signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(input.signature)) throw new Error("Invalid enrollment proof");
        const agentId = getAddress(input.agentId);
        const pending = enrollmentChallenges.get(input.nonce);
        if (!pending || pending.agentId.toLowerCase() !== agentId.toLowerCase() || pending.expiresAt <= Math.floor(Date.now() / 1000))
          throw new Error("Enrollment challenge is missing or expired");
        enrollmentChallenges.delete(input.nonce);
        const signer = await recoverMessageAddress({ message: pending.message, signature: input.signature as Hex });
        if (await options.client.getChainId() !== options.chainId) throw new Error("RPC chain mismatch");
        const blockNumber = await options.client.getBlockNumber({ cacheTime: 0 });
        const code = await options.client.getCode({ address: agentId, blockNumber });
        if (!isExpectedAgentClone(code, options.implementation)) throw new Error("This is not an account from the pinned implementation");
        const [owner, scheme] = await Promise.all([
          options.client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "owner", blockNumber }),
          options.client.readContract({ address: agentId, abi: agentAccountAbi, functionName: "authenticatorScheme", blockNumber }),
        ]);
        if (owner === zeroAddress || signer.toLowerCase() !== owner.toLowerCase() || (scheme !== 1 && scheme !== 2))
          throw new Error("Wallet signature does not match this agent's owner");
        const previous = enrollments.get(agentId.toLowerCase());
        const enrollment: Enrollment = { agentId, owner, scheme: scheme === 2 ? "P-256" : "secp256k1",
          permissions: previous?.permissions ?? { report: false, compute: false } };
        enrollments.set(agentId.toLowerCase(), enrollment);
        record("ENROLLED", agentId, `Owner wallet ${owner} enrolled this agent`);
        sendJson(response, 200, enrollment);
      } catch { sendJson(response, 401, { error: "Owner-signed enrollment failed; request a new challenge and retry" }); }
      return;
    }

    if (request.method === "GET" && (path === "/private/report" || path === "/private/compute")) {
      const resource: Permission = path === "/private/report" ? "report" : "compute";
      await protectedResources[resource](request, response, () => {
        const { session, user } = (request as AgenticRequest<Enrollment>).agentic!;
        record("ALLOWED", session.agentId, `${resource} · 200`);
        sendJson(response, 200, { service: "Service A", resource, agentId: session.agentId,
          owner: user.owner, result: resource === "report" ? "Local report available" : "Local compute credit available" });
      });
      return;
    }
    sendJson(response, 404, { error: "Unknown route" });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 8787, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local service did not bind");
  baseUrl = `http://${host}:${address.port}`;
  return { baseUrl, operatorToken, close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const client = await createVerifiedSepoliaClient(await resolveSepoliaRpcUrl());
  const running = await startDemoService({ client, chainId: SEPOLIA_CHAIN_ID, implementation: SEPOLIA_DEPLOYMENT.implementation,
    audience: "https://service-a.example", port: Number(process.env.AGENTIC_SERVICE_PORT ?? "8787"),
    operatorToken: process.env.AGENTIC_SERVICE_OPERATOR_TOKEN });
  process.stdout.write(`SERVICE_READY ${JSON.stringify({ url: running.baseUrl, audience: "https://service-a.example",
    chainId: SEPOLIA_CHAIN_ID, factory: SEPOLIA_DEPLOYMENT.factory, operatorToken: running.operatorToken })}\n`);
}
