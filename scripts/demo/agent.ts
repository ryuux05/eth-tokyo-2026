import assert from "node:assert/strict";
import { isAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createAgentSdk, requestProofHeaders } from "../../sdk/agent.js";

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

async function signedGet(endpoint: Endpoint, target: string) {
  const proof = await agent.signRequest({ method: "GET", target, body: new Uint8Array() }, endpoint.audience);
  const headers = requestProofHeaders(proof);
  const response = await fetch(`${endpoint.url}${target}`, { headers });
  return { response, headers };
}

if (config.phase === "revoked") {
  const afterRevokeA = await signedGet(config.serviceA, "/private/report");
  const afterRevokeB = await signedGet(config.serviceB, "/private/compute");
  assert.equal(afterRevokeA.response.status, 401, "revoked operating key must fail at Service A");
  assert.equal(afterRevokeB.response.status, 401, "revoked operating key must fail at Service B");
  console.log(`DEMO_RESULT ${JSON.stringify({ phase: "revoked", agentId: config.agentId,
    serviceA: afterRevokeA.response.status, serviceB: afterRevokeB.response.status })}`);
  process.exit(0);
}

if (config.phase !== "active") throw new Error("Invalid demo agent phase");

const ownerResource = await signedGet(config.serviceA, "/private/report");
assert.equal(ownerResource.response.status, 200, "paid owner-associated Service A resource");
assert.equal((await ownerResource.response.json()).agentId.toLowerCase(), config.agentId.toLowerCase());
const aSession = ownerResource.response.headers.get("Agent-Session");
assert(aSession, "Service A must create a session");

const crossAudience = await fetch(`${config.serviceB.url}/private/report`, { headers: ownerResource.headers });
assert.equal(crossAudience.status, 401, "Service A proof must fail at Service B");
const crossSession = await fetch(`${config.serviceB.url}/private/compute`, {
  headers: { "Agent-Session": aSession },
});
assert.equal(crossSession.status, 401, "Service A session must fail at Service B");

const manualResource = await signedGet(config.serviceB, "/private/compute");
assert.equal(manualResource.response.status, 200, "manually enrolled Service B resource");
const bSession = manualResource.response.headers.get("Agent-Session");
assert(bSession, "Service B must create its own session");
const repeatedSession = await fetch(`${config.serviceB.url}/private/compute`, {
  headers: { "Agent-Session": bSession },
});
assert.equal(repeatedSession.status, 200, "Service B session should work at Service B");

const forbiddenRoute = await signedGet(config.serviceB, "/private/admin");
assert.equal(forbiddenRoute.response.status, 403, "valid authentication must not grant admin access");
const replay = await fetch(`${config.serviceA.url}/private/report`, { headers: ownerResource.headers });
assert.equal(replay.status, 401, "reusing one signed request must fail");

console.log(`DEMO_RESULT ${JSON.stringify({ agentId: config.agentId,
  ownerResource: ownerResource.response.status, manualResource: manualResource.response.status,
  crossAudience: crossAudience.status, crossSession: crossSession.status,
  manualSession: repeatedSession.status, forbiddenRoute: forbiddenRoute.response.status,
  replay: replay.status })}`);
