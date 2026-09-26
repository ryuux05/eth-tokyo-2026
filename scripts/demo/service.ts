import { createServer } from "node:http";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { AgenticWorld, requestProofFromHeaders, type Session } from "../../sdk/service.js";

type DemoUser = { id: string; routes: readonly string[] };
type DemoConfig = {
  kind: "owner" | "manual";
  chainId: number;
  audience: string;
  implementation: Address;
  agentId: Address;
  owner: Address;
};

const rawConfig = process.env.DEMO_SERVICE_CONFIG;
if (!rawConfig) throw new Error("Missing local demo service configuration");
const config = JSON.parse(rawConfig) as DemoConfig;
if (!isAddress(config.implementation) || !isAddress(config.agentId) || !isAddress(config.owner)) {
  throw new Error("Invalid local demo address");
}
const client = createPublicClient({ transport: http("http://127.0.0.1:8545") });
const nonceExpiries = new Map<string, number>();
const sessions = new Map<Hex, Session>();

// Each process owns its own user/agent enrollment, entitlements, nonces and sessions.
const paidOwners = new Map<string, DemoUser>([[config.owner.toLowerCase(), {
  id: "paid-owner", routes: ["/private/report"],
}]]);
const enrolledAgents = new Map<string, DemoUser>([[config.agentId.toLowerCase(), {
  id: "enrolled-agent", routes: ["/private/compute"],
}]]);
const association = config.kind === "owner"
  ? { mode: "owner" as const, resolveUser: async (owner: Address) => paidOwners.get(owner.toLowerCase()) ?? null }
  : { mode: "manual" as const, resolveUser: async (agent: Address) => enrolledAgents.get(agent.toLowerCase()) ?? null };

const service = new AgenticWorld<DemoUser>({
  client,
  chainId: config.chainId,
  audience: config.audience,
  pinnedImplementation: config.implementation,
  association,
  requestNonces: { async consume(agentId, nonce, expiresAt) {
    const key = `${agentId.toLowerCase()}:${nonce.toLowerCase()}`;
    if ((nonceExpiries.get(key) ?? 0) > Date.now() / 1000) return false;
    nonceExpiries.set(key, expiresAt);
    return true;
  } },
  sessions: { async put(hash, session) { sessions.set(hash, session); }, async get(hash) { return sessions.get(hash); } },
});

const server = createServer(async (request, response) => {
  const target = request.url ?? "";
  if (request.method !== "GET" || !["/private/report", "/private/compute", "/private/admin"].includes(target)) {
    response.writeHead(404).end();
    return;
  }
  let authenticated: Awaited<ReturnType<typeof service.authenticateRequest>> | Awaited<ReturnType<typeof service.readSession>>;
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 64 * 1024) throw new Error("Demo request body too large");
      chunks.push(bytes);
    }
    const actualRequest = { method: request.method, target, body: new Uint8Array(Buffer.concat(chunks)) };
    const sessionHeader = request.headers["agent-session"];
    authenticated = typeof sessionHeader === "string"
      ? await service.readSession(sessionHeader)
      : await service.authenticateRequest(
        requestProofFromHeaders(request.headers, actualRequest, config.audience), actualRequest,
      );
  } catch {
    response.writeHead(401).end();
    return;
  }
  if (!authenticated) {
    response.writeHead(401).end();
    return;
  }
  if (!authenticated.user?.routes.includes(target)) {
    response.writeHead(403).end();
    return;
  }
  const token = "token" in authenticated && typeof authenticated.token === "string"
    ? authenticated.token : undefined;
  response.writeHead(200, {
    "content-type": "application/json",
    ...(token ? { "Agent-Session": token } : {}),
  }).end(JSON.stringify({ service: config.kind, resource: target, agentId: authenticated.session.agentId }));
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo service did not bind to loopback");
console.log(`DEMO_READY ${JSON.stringify({ kind: config.kind, port: address.port })}`);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
