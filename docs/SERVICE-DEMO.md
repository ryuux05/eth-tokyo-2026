# Service A: permission workbench

This is a **long-running, local-only service** using the real `AgenticWorld` service SDK. Its [operator page](../demo-service/index.html) lets you enroll one agent, change two service-local permissions, and retry resource requests using the *same* `Agent-Session` to observe access change immediately. This is distinct from the [owner portal](PORTAL.md): the portal controls the onchain account and execution policy; Service A controls its own API authorization.

## Start it

From the repository root, run `npm run demo` and leave that terminal open. This single command builds only the demo contracts and Service A page; starts a fresh Osaka Hardhat node; deploys `RealEntryPoint` and `AgentAccountFactory`; and serves Service A. It **does not compile Swift, build MCP, or start the owner portal**. It prints the actual loopback service and RPC URLs, factory and implementation addresses, a random Service A operator key, and the later Codex MCP setup commands. If default ports are occupied, it chooses free nearby ports instead. Point your human wallet's local network to the **printed RPC URL** before sending an owner transaction.

The command also writes a gitignored `.agentic-world.demo.json` for the local MCP and `.agentic-world.demo-state.json` for the next Codex session to discover the actual URLs. Neither file contains the service operator key. Later, when you set up the agent, run `npm run build:mcp` and `npm run build:signer` separately, then use the printed `codex mcp add …` command. The repo-local Agentic World skill is already present at `.agents/skills/agentic-world/SKILL.md`; start the new Codex session **from this repo**. You do not need to download the skill.

`npm run demo` does **not** silently provision a persistent Secure Enclave key or submit an owner-wallet transaction. After building MCP and the signer separately, start Codex or Claude from this repo and ask the skill to create your identity. `agentic_create_identity()` creates or reuses the local P-256 key and opens a one-time localhost approval page in your default browser. Connect your MetaMask-compatible **human owner wallet** to the printed local chain; review the owner, factory, and predicted address; then approve the transaction in the wallet. The page verifies the confirmed account before the MCP reports `0xAGENT`. The MCP does not hold the wallet key or submit the transaction itself. If the default browser has no injected wallet, open the approval URL in a browser where your wallet extension is enabled. The launcher also observes the factory's `AgentCreatedP256` event and writes that agent ID to both generated files. Then paste `0xAGENT` into Service A, unlock the desk with the printed operator key, and select **Enroll agent**. Enrollment checks pinned clone code, a nonzero `owner()`, and an active authenticator scheme. It grants neither resource by default.

The Service A page can stay open while you change permissions. Stopping the demo shuts down Service A and the local Hardhat node. Restarting it creates a **new chain and deployment** and clears enrollments, challenges, sessions, permissions, and the activity log; all are intentionally in memory for this demo. The Secure Enclave key persists locally and may be reused under the same label.

## See the access decision change

1. In Service A, select **Issue challenge**. It returns the service-generated `agentId`, HTTPS `audience`, `chainId`, random `nonce`, `issuedAt`, and `expiresAt`. Copy the whole JSON object.
2. In your Codex/Claude MCP client, call `agentic_session_proof({ challenge: <that JSON object> })`. Use the Secure Enclave-backed identity you created. The MCP signs locally; it does **not** call Service A.
3. Paste only the returned proof JSON into **Signed proof JSON** and select **Create AgentSession**. Service A calls the SDK, which verifies ERC-1271 against the pinned account, consumes the challenge, checks manual enrollment, and creates a service-local session. The session token stays in the page's memory; it is not written to browser storage. A challenge cannot be reused.
4. Select **Try report**. The default response is `403` because the report gate is closed. Select **Grant access** beside Private report, then **Try report** again. The same session now receives `200`. Revoke access and retry: the same session receives `403` again. The compute gate is independent.

Challenges and sessions last up to five minutes in this hands-on demo. If either expires, request a new challenge and proof. A `401` means the service did not accept the session; a `403` means the agent authenticated but this service denied the specific resource. Service-owned permissions are checked on **every** private request, not copied into the session.

## Agent-facing HTTP API

The operator page is only a testing UI. An agent can call the same endpoints directly:

| Endpoint | Input | Output |
| --- | --- | --- |
| `POST /agent/challenge` | JSON `{ "agentId": "0x…" }` | SDK challenge JSON |
| `POST /agent/session` | Signed `AgentAuthentication` proof JSON | `Agent-Session` response header |
| `GET /private/report` | `Agent-Session: <token>` | `200`, `401`, or `403` |
| `GET /private/compute` | `Agent-Session: <token>` | `200`, `401`, or `403` |

The operator-only `/admin/*` routes require the random `X-Operator-Token` printed at startup and reject cross-origin browser requests. Never give this key to the agent. The signed audience is the canonical `https://service-a.example` origin; loopback HTTP transport is a **local-demo exception**, not a production deployment pattern.

## Limits

This example is not a production access service. Its stores are in-memory and its operator key is terminal-issued; it has no durable audit log, billing integration, TLS, rate limiting, or multi-user admin login. Onchain signer revocation prevents **new** proofs but does not retroactively invalidate a session already issued here; existing sessions expire within five minutes. Service permission changes take effect on the next request. See the [service SDK](SDK.md) for integration requirements.
