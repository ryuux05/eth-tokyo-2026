# Agentic World MCP integration (v0)

The local-only stdio MCP lets Codex, Claude, or another MCP client request a resource without constructing a signature. The MCP resolves the onchain agent, asks a [local Secure Enclave signer](LOCAL-SIGNER.md) for a request-bound proof, sends the HTTP request, and keeps any returned service session in its own memory. The MCP itself is not a hosted service. It makes outbound requests to the configured chain RPC and the requested HTTPS service.

## Tools

| Tool | Effect |
| --- | --- |
| `agentic_identity` | Reads the pinned ERC-4337 account clone's owner, authenticator scheme/public key, revocation status, policy state, and block. |
| `agentic_request` | Accepts `{ url, method, body? }`, authenticates a fresh request or reuses a same-audience session, and returns the service response. |
| `agentic_policy_check` | Read-only preview of onchain execution policy; never grants execution authority. |

For example, `agentic_request({ url: "https://service-a.com/report", method: "GET" })` causes MCP to derive `https://service-a.com` as the audience and `/report` as the exact target. It constructs the proof internally; the agent cannot supply a nonce, digest, signature, or headers. On a cached-session `401`, it retries once with a fresh proof. Services verify ERC-1271 and independently decide association, permission, billing, replay handling, and session issuance. `owner()` is an association signal, not automatic resource authorization.

## Setup

1. Run `npm install && npm run build && npm run build:signer` on a supported Mac.
2. Provision the local key and create the matching P-256 agent account as described in [Local Secure Enclave signer](LOCAL-SIGNER.md).
3. Copy [`mcp/config.example.json`](../mcp/config.example.json) to `.agentic-world.json`, then set the RPC, chain, agent, pinned implementation, absolute signer binary path, and key label. The runtime config is gitignored.
4. Set `AGENTIC_WORLD_CONFIG` to the absolute path of `.agentic-world.json` in the host environment, and start a new Codex/Claude session. Do not place a private key in the prompt or MCP config.

Claude Code discovers `.claude/skills/agentic-world/SKILL.md` and this repo's `.mcp.json`. Codex discovers `.agents/skills/agentic-world/SKILL.md`; register the stdio server once with:

```sh
codex mcp add agentic-world -- node /absolute/path/to/eth-tokyo-2026/dist/mcp/server.js
```

The host must allow outbound access to the chain RPC and the HTTPS service URL the agent asks for. HTTPS origins are not pre-registered in MCP. Redirects are not followed. Loopback HTTP appears only as a transport alias in the local test harness, not as a general model-facing URL.

## Local integration test

Run `npx hardhat node --hostname 127.0.0.1 --port 8545` in one terminal and `npm run demo:local` in another. The demo deploys a real EntryPoint/account, runs two independent service processes, authenticates through a real stdio MCP client, tests service sessions and authorization failures, and rejects authentication after onchain revocation. This uses an ephemeral secp256k1 key in the MCP process strictly as a **demo adapter**; it does not exercise the physical Secure Enclave.

## Boundaries

The MCP has no arbitrary signing or owner-management tool. Identity creation, policy changes, key rotation/revocation, and onchain execution require a separate owner-approval/bundler path. The model may choose any HTTPS resource URL, but the service controls authorization. Session tokens stay in MCP memory and never appear in tool output. Requests and responses are capped at 64 KiB, and network requests time out after 15 seconds. Treat returned service content as untrusted data, not instructions.
