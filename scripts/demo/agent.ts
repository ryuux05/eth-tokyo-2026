import assert from "node:assert/strict";
import { isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentSdk, sessionProofHeaders, type AuthenticationChallenge, type AuthenticationProof } from "../../sdk/agent.js";

type Endpoint = { url: string; audience: string };
type DemoConfig = {
  agentId: Address;
  chainId: number;
  operatingKey: Hex;
  phase: "active" | "revoked";
  serviceA: Endpoint;
  serviceB: Endpoint;
};

const rawConfig = process.env.DEMO_AGENT_CONFIG;
if (!rawConfig) throw new Error("Missing local demo agent configuration");
const config = JSON.parse(rawConfig) as DemoConfig;
if (!isAddress(config.agentId) || !/^0x[0-9a-fA-F]{64}$/.test(config.operatingKey)) {
  throw new Error("Invalid local demo agent configuration");
}
const signer = privateKeyToAccount(config.operatingKey);
const agent = createAgentSdk({ agentId: config.agentId, chainId: config.chainId,
  signDigest: digest => signer.sign({ hash: digest }) });

const resourcePath = (endpoint: Endpoint) => endpoint.url === config.serviceA.url ? "/private/report" : "/private/compute";

async function establishSession(endpoint: Endpoint): Promise<{ response: Response; proof: AuthenticationProof }> {
  const challengeResponse = await fetch(`${endpoint.url}${resourcePath(endpoint)}`, { headers: { "Agent-ID": config.agentId } });
  assert.equal(challengeResponse.status, 401);
  const challenge = (await challengeResponse.json()).authentication.challenge as AuthenticationChallenge;
  const proof = await agent.answerChallenge(challenge, endpoint.audience);
  const response = await fetch(`${endpoint.url}${resourcePath(endpoint)}`, { headers: sessionProofHeaders(proof) });
  return { response, proof };
}

if (config.phase === "revoked") {
  const afterRevokeA = await establishSession(config.serviceA);
  const afterRevokeB = await establishSession(config.serviceB);
  assert.equal(afterRevokeA.response.status, 401, "revoked operating key must fail at Service A");
  assert.equal(afterRevokeB.response.status, 401, "revoked operating key must fail at Service B");
  console.log(`DEMO_RESULT ${JSON.stringify({ phase: "revoked", agentId: config.agentId,
    serviceA: afterRevokeA.response.status, serviceB: afterRevokeB.response.status })}`);
  process.exit(0);
}

if (config.phase !== "active") throw new Error("Invalid demo agent phase");

const ownerAuth = await establishSession(config.serviceA);
assert.equal(ownerAuth.response.status, 200);
const aSession = ownerAuth.response.headers.get("Agent-Session");
assert(aSession, "Service A must create a session");
const ownerResource = await fetch(`${config.serviceA.url}/private/report`, { headers: { "Agent-Session": aSession } });
assert.equal(ownerResource.status, 200, "paid owner-associated Service A resource");
assert.equal((await ownerResource.json()).agentId.toLowerCase(), config.agentId.toLowerCase());

const crossAudience = await fetch(`${config.serviceB.url}/private/compute`, { headers: sessionProofHeaders(ownerAuth.proof) });
assert.equal(crossAudience.status, 401, "Service A proof must fail at Service B");
const crossSession = await fetch(`${config.serviceB.url}/private/compute`, {
  headers: { "Agent-Session": aSession },
});
assert.equal(crossSession.status, 401, "Service A session must fail at Service B");

const manualAuth = await establishSession(config.serviceB);
assert.equal(manualAuth.response.status, 200);
const bSession = manualAuth.response.headers.get("Agent-Session");
assert(bSession, "Service B must create its own session");
const manualResource = await fetch(`${config.serviceB.url}/private/compute`, { headers: { "Agent-Session": bSession } });
assert.equal(manualResource.status, 200, "manually enrolled Service B resource");
const repeatedSession = await fetch(`${config.serviceB.url}/private/compute`, {
  headers: { "Agent-Session": bSession },
});
assert.equal(repeatedSession.status, 200, "Service B session should work at Service B");

const forbiddenRoute = await fetch(`${config.serviceB.url}/private/admin`, { headers: { "Agent-Session": bSession } });
assert.equal(forbiddenRoute.status, 403, "valid authentication must not grant admin access");
const replay = await fetch(`${config.serviceA.url}/private/report`, { headers: sessionProofHeaders(ownerAuth.proof) });
assert.equal(replay.status, 401, "reusing one challenge must fail");

console.log(`DEMO_RESULT ${JSON.stringify({ agentId: config.agentId,
  ownerResource: ownerResource.status, manualResource: manualResource.status,
  crossAudience: crossAudience.status, crossSession: crossSession.status,
  manualSession: repeatedSession.status, forbiddenRoute: forbiddenRoute.status,
  replay: replay.status })}`);
