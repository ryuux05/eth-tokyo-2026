import { createServer } from "node:http";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { AgenticWorld, type AuthenticationChallenge, type AuthenticationProof, type Session } from "../../sdk/service.js";

type DemoUser = { id: string; routes: readonly string[] };
type DemoConfig = {
  kind: "owner" | "manual";
  chainId: number;
  audience: string;
  rpcUrl: string;
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
const client = createPublicClient({ transport: http(config.rpcUrl) });
const challenges = new Map<Hex, AuthenticationChallenge>();
const consumedChallenges = new Set<Hex>();
const sessions = new Map<Hex, Session>();

// Each process owns its own user/agent enrollment, entitlements, challenges and sessions.
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
  authorizeSession: async (_identity, user) => user.routes.length > 0,
  challenges: {
    async put(challenge) { challenges.set(challenge.nonce, challenge); },
    async get(nonce) { return consumedChallenges.has(nonce) ? undefined : challenges.get(nonce); },
    async consume(nonce) {
      if (consumedChallenges.has(nonce) || !challenges.has(nonce)) return false;
      consumedChallenges.add(nonce);
      return true;
    },
  },
  sessions: { async put(hash, session) { sessions.set(hash, session); }, async get(hash) { return sessions.get(hash); } },
});

const server = createServer(async (request, response) => {
  const target = request.url ?? "";
  if (request.method === "POST" && ["/agent/challenge", "/agent/session"].includes(target)) {
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > 4096) throw new Error("Authentication payload too large");
        chunks.push(bytes);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      if (target === "/agent/challenge") {
        if (typeof input.agentId !== "string" || !isAddress(input.agentId)) throw new Error("Invalid agent ID");
        const challenge = await service.createChallenge(input.agentId);
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(challenge));
      } else {
        const authenticated = await service.authenticate(input as AuthenticationProof);
        response.writeHead(200, { "content-type": "application/json", "Agent-Session": authenticated.token })
          .end(JSON.stringify({ agentId: authenticated.session.agentId, owner: authenticated.session.owner }));
      }
    } catch {
      response.writeHead(401).end();
    }
    return;
  }
  if (request.method !== "GET" || !["/private/report", "/private/compute", "/private/admin"].includes(target)) {
    response.writeHead(404).end();
    return;
  }
  let authenticated: Awaited<ReturnType<typeof service.readSession>>;
  try {
    const sessionHeader = request.headers["agent-session"];
    authenticated = typeof sessionHeader === "string" ? await service.readSession(sessionHeader) : undefined;
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
  response.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ service: config.kind, resource: target, agentId: authenticated.session.agentId }));
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo service did not bind to loopback");
console.log(`DEMO_READY ${JSON.stringify({ kind: config.kind, port: address.port })}`);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
