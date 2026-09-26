# Agent and service SDKs

The dependency order is `contracts → core → agent/service`. There is no Agentic World backend on a service's authentication path. Build the private repository package with `npm run build:sdk`; it is not yet a published npm release. See [implementation status](V0-IMPLEMENTATION.md) and the [current Sepolia deployment caveats](../README.md).

| Entry point | Responsibility |
| --- | --- |
| `agentic-world/core` | Account/factory ABIs, proof formats, `sessionProofHeaders`, policy encoding and account checks. |
| `agentic-world/agent` | Answer challenges using an injected signer; proof-header helper and lower-level UserOperation signing. |
| `agentic-world/service` | Resource middleware: challenge issuance, ERC-1271 verification, association, admission and service-local sessions. |

## Resource-first flow: no separate authentication routes

**Services mount middleware on their resource routes. They do not need `/agent/challenge` or `/agent/session`.**

| Resource response | Agent action |
| --- | --- |
| `200` | Use the resource; no authentication needed. |
| `401` explicitly offering `AgenticWorld` | Authenticate at this same resource URL as below. |
| Ordinary `401` / OAuth without `AgenticWorld` | Follow the service's own authentication; do not guess Agentic World endpoints. |
| `403` | Service permission denied; reauthentication does not grant access. |
| `400` / `503` | Malformed credentials / verification unavailable; report the error, do not start a signing loop. |

1. Agent requests `GET /private/report`. With no ID/session, the middleware responds `401` with an Agentic World discovery offer.
2. Agent retries **the same URL** with `Agent-ID: 0xAGENT`. Middleware creates and stores an agent-bound random challenge and returns it in the `401` body. If the initial request already has an ID, it gets the challenge immediately.
3. Agent passes `authentication.challenge` unchanged to local MCP `agentic_session_proof({ challenge })`. MCP signs locally and returns proof fields plus a ready-to-send `headers` object. MCP never sends HTTP.
4. Agent retries **the same method, URL, and body** with those proof headers, without `Agent-Session`.
5. Middleware checks the stored challenge, chain/audience/time, pinned account and ERC-1271 signature, consumes the nonce atomically, resolves the local user, and checks session admission **and this resource's permission before issuing a session**.
6. If allowed, the resource handler runs. Its response includes `Agent-Session` and `Agent-Session-Expires-At` (Unix seconds). The response body is the resource, not a separate session response.
7. Later requests carry only `Agent-Session: <token>`; middleware rechecks current service association and route permissions.

The discovery header is:

```http
WWW-Authenticate: AgenticWorld realm="Service B", audience="https://service-b.example", transport="resource"
Cache-Control: no-store
```

Its JSON body includes `authentication: { scheme: "AgenticWorld", audience: "https://service-b.example", transport: "resource" }`. With a valid `Agent-ID`, that object additionally contains `challenge`, with `agentId`, `audience`, `chainId`, a 32-byte hex `nonce`, `issuedAt`, and `expiresAt` (Unix seconds). Without an ID, discovery creates no nonce.

Proof transport preserves every challenge field:

| Header | Signed proof field |
| --- | --- |
| `Agent-ID` | `agentId` |
| `Agent-Audience` | `audience` |
| `Agent-Chain-ID` | `chainId` as decimal |
| `Agent-Nonce` | `nonce` |
| `Agent-Issued-At` | `issuedAt` as decimal |
| `Agent-Expires-At` | `expiresAt` as decimal |
| `Agent-Signature` | `signature` |

Use MCP's returned `headers` or `sessionProofHeaders(proof)` from the core/agent SDK. Incomplete, duplicate, or conflicting proof/session headers are rejected. Invalid/expired/replayed proofs return a plain `401` without issuing another challenge; missing/expired sessions may receive a new offer. Never forward proofs or tokens across origins or redirects.

## Service integration

The following Express-style example assumes your application already supplies `app`, `rpcClient`, durable stores, and `db`. Express is not an SDK dependency. Mount middleware only on routes offering Agentic World, after public/human-auth handling when appropriate.

```ts
import { AgenticWorld, type AgenticRequest } from "agentic-world/service";

type User = { report: boolean; agentAccess: boolean };

const agentic = new AgenticWorld<User>({
  client: rpcClient,
  chainId: 11155111,
  audience: "https://service-b.example",
  // Sepolia implementation is pinned by the SDK; never accept a client pin.
  challenges: durableAtomicChallengeStore,
  sessions: durableSessionStore,
  association: {
    mode: "owner",
    resolveUser: owner => db.user.findByWallet(owner),
  },
  authorizeSession: async (_identity, user) => user.agentAccess,
});

const requireReport = agentic.middleware({
  realm: "Service B",
  authorize: ({ user }) => user.report, // checked on every resource request
});

app.get("/private/report", (req, res, next) => {
  // Explicit catch also forwards application errors on Express 4.
  void requireReport(req, res, () => {
    const { session } = (req as AgenticRequest<User>).agentic!;
    res.json({ agentId: session.agentId, result: "Private report" });
  }).catch(next);
});
```

That resource route is the entire HTTP authentication integration. The middleware does not consume the request body, so application JSON parsing/handlers continue to work normally. It does not rewrite other routes' ordinary `401` responses.

- **Manual association (Service A):** configure `{ mode: "manual", resolveUser: agentId => db.user.findByAgent(agentId) }`. Each logged-in end user enrolls their agent through your existing account-management flow. Enrollment itself must be authenticated.
- **Owner association (Service B):** resolve the service user by its previously verified wallet. The SDK reads `owner()` from the pinned agent account, not an agent-supplied claim. Association does not grant all the owner's permissions.
- `authorizeSession` is optional service-wide admission. Middleware's required `authorize` callback decides this resource's permission; both must allow before a fresh session is stored.
- Removed association or denied permission returns `403`, with no new token or authentication offer. RPC/store/authorization backend errors fail closed with sanitized `503`; no protected handler runs. Application errors after authorization go to the application's error handler.
- The SDK checks exact v0 ERC-1167 clone code and calls `0xAGENT.isValidSignature(...)`; owner and signature checks use the same fresh RPC block. Other chains require a trusted `pinnedImplementation` at startup. Sepolia rejects a different explicit pin.

## Agent SDK and signing

Generic Codex/Claude agents use MCP's `agentic_session_proof`. Integrators with their own signer can use:

```ts
import { createAgentSdk, sessionProofHeaders } from "agentic-world/agent";

const agent = createAgentSdk({
  agentId,
  chainId,
  signDigest: digest => operatingAccount.sign({ hash: digest }),
});
// challenge came from the requested resource's 401, after checking its
// AgenticWorld offer, selected agent, chain, and trusted HTTPS audience.
const proof = await agent.answerChallenge(challenge, "https://service-a.example");
const response = await fetch(resourceUrl, {
  headers: sessionProofHeaders(proof),
  redirect: "error",
});
const token = response.headers.get("Agent-Session");
// On success, response already contains the resource. Cache token only for
// this service origin and agent; use Agent-Session on subsequent requests.
```

`signDigest` must return 65-byte secp256k1 or 64-byte P-256 `r || s` over the digest, not EIP-191 `personal_sign`. The [local hardware signer](LOCAL-SIGNER.md) deliberately accepts only structured challenges; it is not an arbitrary digest signing interface. The signed `AgentAuthentication` establishes identity/session authority, **not** a method/body-bound transaction approval or behavioral mandate. Resource authorization remains local to the service.

## Integration checklist and limits

- Use HTTPS transport and a canonical HTTPS audience. Loopback Service A/B have explicitly configured HTTPS audience identifiers solely for local development.
- Supply durable `ChallengeStore` / `SessionStore` adapters shared across workers. Challenge consumption must be atomic; retain challenges through expiry. The SDK stores only token hashes. Default challenge/session TTL is 60 seconds; configurable range is 1–300.
- Add application rate limits, body limits, TLS and protected enrollment. Challenge creation performs RPC reads, so rate-limit resource authentication attempts as well as normal traffic. Never log proof headers or raw session tokens.
- Middleware does not revalidate onchain signer state for an existing session. Revocation blocks new proofs but an issued token can survive until expiry unless the service rechecks/invalidate sessions. Fresh database permission changes affect the next request.
- For browser clients, configure restricted CORS for the proof/session headers and expose `Agent-Session`, `Agent-Session-Expires-At`, and `WWW-Authenticate` as needed. Server-to-server agents do not need CORS.
- For mutating requests, authentication retries must preserve the request. Use service-owned idempotency keys when appropriate; do not retry after an ambiguous network failure because the handler may have executed. Authentication proofs are single-use, not an exactly-once execution mechanism.
- Test public `200`, ordinary/OAuth `401` unchanged, ID discovery/challenge, same-resource signed retry, replay/concurrent replay, session expiry, permission removal, and backend outages.

Lower-level `createChallenge`, `authenticate`, `readSession`, and compatibility `issueChallenge` remain available for custom transports, but middleware users do not expose them as HTTP endpoints. Legacy request-bound proof helpers remain separate; they are not the active MCP flow. `signUserOperationHash` and `encodeAgentExecution` do not supply a bundler or fund/submit transactions.

Working integrations: [Service A](../demo-service/server.ts), [Service B](../demo-service-b/server.ts). Tests: [middleware](../test/ServiceMiddleware.ts), [MCP end-to-end](../test/McpE2E.ts).
