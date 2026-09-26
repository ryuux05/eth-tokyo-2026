# Agentic World MCP integration (v0)

The local-only stdio MCP lets Codex, Claude, or another MCP client request a resource without constructing a signature. The MCP resolves the onchain agent, asks a [local Secure Enclave signer](LOCAL-SIGNER.md) for a request-bound proof, sends the HTTP request, and keeps any returned service session in its own memory. The MCP itself is not a hosted service. It makes outbound requests to the configured chain RPC and the requested HTTPS service.

## Tools

| Tool | Effect |
| --- | --- |
| `agentic_identity` | Reads the pinned ERC-4337 account clone's owner, authenticator scheme/public key, revocation status, policy state, and block; reports an unconfigured identity before bootstrap. |
| `agentic_request` | Normal path: accepts `{ url, method, body? }`, authenticates a fresh request or reuses a same-audience session, and returns the service response. |
| `agentic_authenticate` | Optional explicit `GET` to a service URL, retaining a returned session. It is not required before `agentic_request` and does not guarantee a session. |
| `agentic_create_identity` | Prepares a factory transaction for the human owner; does not provision a key or submit the transaction. |
| `agentic_set_policy` | Validates policy rules and prepares an owner-only `setPolicy` transaction; does not submit it. |
| `agentic_rotate_authenticator` | Checks current identity and prepares an owner-only key rotation transaction; does not submit it. |
| `agentic_policy_check` | Read-only preview of onchain execution policy; never grants execution authority. |

For example, `agentic_request({ url: "https://service-a.com/report", method: "GET" })` causes MCP to derive `https://service-a.com` as the audience and `/report` as the exact target. It constructs the proof internally; the agent cannot supply a nonce, digest, signature, or headers. On a cached-session `401`, it retries once with a fresh proof. Services verify ERC-1271 and independently decide association, permission, billing, replay handling, and session issuance. `owner()` is an association signal, not automatic resource authorization.

The three owner tools return `status: "OWNER_TRANSACTION_REQUIRED"` and transaction data (`from`, `to`, `chainId`, `value`, `data`). An independent human wallet must review and send it. A tool response is neither an owner signature nor proof that the action has happened. `agentic_create_identity` requires a trusted `factory` and a provisioned local key; after the wallet transaction confirms, put the deployed address in `agentId`. `agentic_set_policy` and `agentic_rotate_authenticator` require an existing configured identity. `agentic_authenticate` performs a real `GET` at the supplied URL, so services should provide a safe authentication endpoint if they want pre-authentication without fetching a resource.

## Setup

1. Run `npm install && npm run build && npm run build:signer` on a supported Mac.
2. Provision the local key as described in [Local Secure Enclave signer](LOCAL-SIGNER.md).
3. Copy [`mcp/config.example.json`](../mcp/config.example.json) to `.agentic-world.json`, then set the RPC, chain, trusted factory, pinned implementation, absolute signer binary path, and key label. The runtime config is gitignored. You may omit `agentId` until the owner sends the transaction prepared by `agentic_create_identity`; add the resulting address afterward.
4. Set `AGENTIC_WORLD_CONFIG` to the absolute path of `.agentic-world.json` in the host environment, and start a new Codex/Claude session. Do not place a private key in the prompt or MCP config.

Claude Code discovers `.claude/skills/agentic-world/SKILL.md` and this repo's `.mcp.json`. Codex discovers `.agents/skills/agentic-world/SKILL.md`; register the stdio server once with:

```sh
codex mcp add agentic-world -- node /absolute/path/to/eth-tokyo-2026/dist/mcp/server.js
```

The host must allow outbound access to the chain RPC and the HTTPS service URL the agent asks for. HTTPS origins are not pre-registered in MCP. Redirects are not followed. Loopback HTTP appears only as a transport alias in the local test harness, not as a general model-facing URL. A P-256 deployment now requires an EIP-7951-compatible chain with the native `P256VERIFY` precompile at `0x100`; validation fails closed without it.

## Local integration test

Run `npx hardhat node --hostname 127.0.0.1 --port 8545` in one terminal and `npm run demo:local` in another. For repeated runs against a persistent node whose block clock has drifted ahead of wall time, use a fresh node/port and set `DEMO_RPC_URL` for the demo process. The demo deploys a real EntryPoint/account, runs two independent service processes, discovers all seven tools through a real stdio MCP client, checks owner transaction preparation and optional authentication, tests service sessions and authorization failures, and rejects authentication after onchain revocation. This uses an ephemeral secp256k1 key in the MCP process strictly as a **demo adapter**; it does not exercise the physical Secure Enclave.

## Boundaries

The MCP has no arbitrary signing or owner-transaction submission tool. The new owner tools only prepare transaction data. Identity creation, policy changes, and key rotation require the human wallet; revocation and onchain execution are not exposed through MCP. The model may choose any HTTPS resource URL, but the service controls authorization. Session tokens stay in MCP memory and never appear in tool output. Requests and responses are capped at 64 KiB, and network requests time out after 15 seconds. Treat returned service content as untrusted data, not instructions.
