# Service A: permission workbench

This is a **long-running, loopback-only service** using the real `AgenticWorld` service SDK against Sepolia. Each end user enrolls their agent with an owner-wallet signature. Its [operator page](../demo-service/index.html) changes two service-local permissions; retrying with the same `Agent-Session` shows them take effect immediately. The separate [owner portal](PORTAL.md) controls onchain identity and execution policy, not Service A's API permissions.

## Start it

Run `npm run demo` from the repository root. It builds the Service A/B pages, verifies the pinned Sepolia deployment, and serves A at `http://127.0.0.1:8787` and B at `http://127.0.0.1:8797`. It prints a random Service A operator key. It does not start Hardhat, deploy contracts, build MCP/Swift, or provision a key. Occupied ports fail explicitly; use `AGENTIC_SERVICE_A_PORT` and `AGENTIC_SERVICE_B_PORT` to choose others. Both `/private/report` endpoints use Sepolia identity verification. Service A also offers `/private/compute`.

Set up the local MCP separately with `agentic-world:init`; it builds MCP, portal and the host signer, then creates a persistent Sepolia config. Repo skills are available to Codex and Claude from this checkout; do not install a duplicate personal copy for that session. The services use the same private Sepolia RPC configuration if present, or the default public endpoint. They never implicitly load the old Hardhat config. See the [installation instructions](../README.md#use-the-skill-in-codex-or-claude-code).

Ask `agentic-world:create -a "Research"` to provision/reuse a local P-256 key and open the owner-wallet page. Connect a funded Sepolia wallet and approve the factory transaction. MCP verifies the account and saves its agent ID. In Service A, paste that ID, connect the same owner wallet, and sign the service enrollment message. Enrollment verifies wallet control against the pinned account's `owner()` and grants neither resource by default. Unlock the operator desk separately with the printed key to manage permissions; never give that operator key to the agent.

Stopping the command closes both services. Restarting clears their in-memory enrollments, challenges, sessions, permissions and activity logs; Sepolia identities and local hardware keys persist. `npm run demo:hardhat` remains an explicit developer-only local-chain launcher.

Service B demonstrates owner-derived association: register your owner wallet at its page with a message signature, then ask the agent to access `http://127.0.0.1:8797/private/report`. Its service-issued challenge requires the agent's own proof; `owner()` associates that proof with the registered wallet. No manual agent enrollment is needed there. Its test audience is `https://service-b.example`.

## See the access decision change

1. In Service A, select **Issue challenge**. The page requests `/private/report` with `Agent-ID` and reads the challenge from its `401` response. It returns the service-generated `agentId`, HTTPS `audience`, `chainId`, random `nonce`, `issuedAt`, and `expiresAt`. Copy the whole JSON object.
2. In your Codex/Claude MCP client, call `agentic_session_proof({ challenge: <that JSON object> })`. Use the Secure Enclave-backed identity you created. The MCP signs locally; it does **not** call Service A.
3. Paste only the returned proof JSON into **Signed proof JSON** and select **Create AgentSession**. The page retries `/private/report` with proof headers. Middleware verifies ERC-1271, consumes the challenge, checks enrollment and report permission, and only then returns the report plus a service-local session. The session token stays in the page's memory; it is not written to browser storage. A challenge cannot be reused.
4. With the default closed report gate, step 3 returns `403` without a session. Select **Grant access** beside Private report, obtain a new challenge, sign it, and submit the new proof. You now get the report and a session. Select **Try report**, revoke access and retry with that same session: it receives `403`. Grant again and it receives `200`. The compute gate is independent.

Challenges and sessions last up to five minutes in this hands-on demo. If either expires, request a new challenge and proof. A `401` means the service did not accept the session; a `403` means the agent authenticated but this service denied the specific resource. Service-owned permissions are checked on **every** private request, not copied into the session.

## Agent-facing HTTP API

The operator page is only a testing UI. An agent can call the same endpoints directly:

| Endpoint | Input | Output |
| --- | --- | --- |
| `GET /private/report` | No authentication | `401` AgenticWorld discovery |
| `GET /private/report` | `Agent-ID: 0x…` | `401` with `authentication.challenge` |
| `GET /private/report` | Proof headers returned by MCP | Resource + `Agent-Session` if permitted; otherwise denial |
| `GET /private/report` | `Agent-Session: <token>` | `200`, `401`, or `403` |
| `GET /private/compute` | `Agent-Session: <token>` | `200`, `401`, or `403` |

No `/agent/challenge` or `/agent/session` route is installed; SDK middleware handles everything on each resource route. See [SDK.md](SDK.md) for the header format.

The operator-only `/admin/*` routes require the random `X-Operator-Token` printed at startup and reject cross-origin browser requests. Never give this key to the agent. The signed audience is the canonical `https://service-a.example` origin; loopback HTTP transport is a **local-demo exception**, not a production deployment pattern.

## Limits

This example is not a production access service. Its stores are in-memory and its operator key is terminal-issued; it has no durable audit log, billing integration, TLS, rate limiting, or multi-user admin login. Onchain signer revocation prevents **new** proofs but does not retroactively invalidate a session already issued here; existing sessions expire within five minutes. Service permission changes take effect on the next request. See the [service SDK](SDK.md) for integration requirements.
