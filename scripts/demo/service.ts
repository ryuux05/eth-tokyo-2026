import { createServer } from "node:http";
import { createPublicClient, http, isAddress, type Address, type Hex } from "viem";
import { AgenticWorld, type AuthenticationChallenge, type AgenticRequest, type Session } from "../../sdk/service.js";

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

const requireResource = service.middleware({ authorize: ({ user }, request) => user.routes.includes(request.url ?? "") });
const server = createServer(async (request, response) => {
  const target = request.url ?? "";
  if (request.method !== "GET" || !["/private/report", "/private/compute", "/private/admin"].includes(target)) {
    response.writeHead(404).end();
    return;
  }
  await requireResource(request, response, () => {
    const { session } = (request as AgenticRequest<DemoUser>).agentic!;
    response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ service: config.kind, resource: target, agentId: session.agentId }));
  });
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Demo service did not bind to loopback");
console.log(`DEMO_READY ${JSON.stringify({ kind: config.kind, port: address.port })}`);
process.on("SIGTERM", () => server.close(() => process.exit(0)));
