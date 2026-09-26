# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

**Architecture freeze:** Agentic World v0 uses an ERC-4337 / ERC-7579 smart
account, an `AgentValidator` for operating-key authentication and ERC-1271, and an
`AgentPolicyHook` plus `PolicyEngine` for owner-controlled onchain execution.
The protocol lets services verify signed authentication challenges independently and keep their own
authorization rules, with manual or `owner()`-derived agent association. See the
[v0 architecture](docs/ARCHITECTURE-v0.md). The local MCP signs service-issued
challenges and returns the proof to the agent; it never proxies resource requests. P-256 verification uses EIP-7951's native `0x100` precompile;
EIP-8141 + ERC-8286 remain future work.

Start with the [current implementation](docs/V0-IMPLEMENTATION.md),
[architecture](docs/ARCHITECTURE-v0.md), [owner portal guide](docs/PORTAL.md),
and [design system](DESIGN.md). The [protocol](docs/PROTOCOL.md),
[policy](docs/POLICY.md), [Core SDK](docs/CORE-SDK.md), [service SDK](docs/SDK.md),
and [implementation plan](docs/IMPLEMENTATION.md) describe the current v0 path.
For Codex/Claude Code integration, see the [local MCP server and skills](docs/MCP.md).
To try live service-owned permissions in a browser, see the [Service A permission workbench](docs/SERVICE-DEMO.md).
Legacy EIP-7702 code and compatibility helpers are identified separately.

## Idea

Give an agent a persistent Ethereum smart account that it can use to authenticate
across services without borrowing a human's login session or access tokens. The
human retains control of the identity and its operating signers.

Agentic World is an authentication layer, not a mandate manager or a universal
permission system. It verifies which agent signed a request. Each service can
associate that agent with one of its users through explicit local enrollment
(`manual`) or by resolving `owner()` on a trusted agent account (`owner`). It
cannot verify the intent of a black-box model or enforce how the agent behaves
offchain. Each service decides whether and how that agent may access its resources.

## v0 scope

- An ERC-4337 / ERC-7579 modular agent account with owner binding,
  `AgentValidator`, and owner-controlled `AgentPolicyHook`.
- Service-issued, expiring challenges with single-use random nonces; the agent
  gets a short-lived, service-local session after ERC-1271 verification.
- A separate agent signing SDK and service verification SDK.
- Two independent services recognizing the same agent with different local permissions.
- A demonstration where a service chooses manual enrollment or owner-based
  association, then separately decides whether a paid account permits agent access.

Services verify proofs and relevant onchain identity state without depending on
an Agentic World-hosted authentication backend. They retain responsibility for
their own authorization, access policies, replay prevention, rate limits, and billing.

A global permission registry, onchain service ACLs, and universal payment policies
are not part of the core identity protocol.

## Status

The repository now contains `AgentAccount4337`, `AgentAccountFactory`,
`AgentValidator`, `AgentPolicyHook`, the Core/agent/service SDKs, local contract
tests, and a redesigned owner portal. The factory deploys an initialized
ERC-1167 clone and binds its owner to the human transaction sender. The service
SDK accepts that clone only when its runtime bytecode points to a trusted,
pinned implementation; the service-facing `AgenticWorld` manual/owner API is
unchanged. The old `AgentAccount` and `MandateRegistry` remain as historical
prototype code, not v0 deployment components.

This is **not yet a deployed, end-to-end public-network demo**. A local integration test
uses the official EntryPoint v0.8 contract to execute a signed UserOperation.
A separate local demo has an agent process authenticate to two independent
SDK-backed HTTP services, and a real stdio MCP client exercises the same identity
and services through three semantic tools. Neither path uses a bundler. There is
no public factory deployment, live KMS adapter, or production-grade HTTP service
and durable nonce/session store. The long-running Service A workbench uses
intentionally in-memory stores and live local permissions. The local MCP has a
challenge-proof tool, a macOS Secure Enclave signer adapter, and a temporary
browser wallet approval flow for identity creation. The physical-key and
MetaMask path still needs a hands-on run on a supported Mac. Only the single-call, revert-on-error
ERC-7579 execution mode is enabled; all onchain actions are default-denied until
the owner installs a policy. See the [implementation status and security limits](docs/V0-IMPLEMENTATION.md).

To run the checks:

```sh
npm install
npm run build
npm test
npm run typecheck
```

For the interactive local workbench, run **one command** and leave it open:

```sh
npm run demo
```

It builds only the demo contracts and Service A page, starts a fresh Hardhat
node, deploys the factory, and serves SDK-backed Service A. It selects free
loopback ports and prints the service URL and operator key.
MCP and Secure Enclave signer builds are separate steps for your later agent
setup; `npm run demo` never compiles Swift, provisions a key, or sends an
owner-wallet transaction. The MCP creates a key only when you explicitly ask
it to create an identity. See the [interactive demo guide](docs/SERVICE-DEMO.md).

### Use the skill in Codex or Claude Code

The skill is already checked into this repo. [Codex finds](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills) `.agents/skills/agentic-world/SKILL.md`, and [Claude Code finds](https://code.claude.com/docs/en/skills#choose-where-skills-load) `.claude/skills/agentic-world/SKILL.md` when started from this repository. There is no separate skill installation command. The skill teaches the workflow; the local MCP server supplies the signing tools.

Keep `npm run demo` running. When you are ready to configure the agent, run these **separately** in another terminal:

```sh
npm run build:mcp
npm run build:signer
dist/signer/agentic-signer availability
```

Start a Codex or Claude session from this repo and say “Create an Agentic World identity.” The skill calls `agentic_create_identity()` with no arguments. That explicit call creates or reuses a local Secure Enclave P-256 key, opens a temporary localhost page in your default browser, and asks you to connect a MetaMask-compatible wallet. **You** select the human owner account and confirm the factory transaction on the printed local chain. The MCP never sees your wallet key or submits the transaction. The page verifies the confirmed onchain account and reports `0xAGENT` back to the agent; the MCP updates its local config. The demo also detects the factory event and updates `.agentic-world.demo-state.json`. The default key label is `agentic-world-demo`; if you set `AGENTIC_DEMO_SIGNER_LABEL`, that label is used instead. The owner portal is optional.

For **Codex**, register the MCP once, check it, then start a new session from this repo:

```sh
codex mcp add agentic-world --env AGENTIC_WORLD_CONFIG="$PWD/.agentic-world.demo.json" -- node "$PWD/dist/mcp/server.js"
codex mcp list
codex
```

For **Claude Code**, the repo's `.mcp.json` already declares the server. Set its runtime config path in the shell and start Claude here; approve the project MCP server if prompted:

```sh
export AGENTIC_WORLD_CONFIG="$PWD/.agentic-world.demo.json"
claude mcp list
claude
```

Claude Code's `/mcp` screen can confirm the connection. For setup details, see the [MCP guide](docs/MCP.md) and [local signer guide](docs/LOCAL-SIGNER.md). The service operator key is **not** in the skill or MCP config; keep it in the Service A operator page only.

To deploy and exercise the complete local RPC + HTTP path, start a Hardhat node
in one terminal and run the smoke script in another:

```sh
npx hardhat node --hostname 127.0.0.1 --port 8545
# separate terminal
npm run demo:local
```

The script prints temporary deployment addresses and checks a policy-allowed
UserOperation, owner-based access at Service A (200), manual enrollment at
Service B (200), distinct sessions, cross-service proof rejection (401),
service-local admin denial (403), challenge replay rejection (401), and fresh-proof
rejection at both services after onchain key revocation (401/401). It uses
publicly known Hardhat owner keys, an ephemeral operating key passed only to
the demo agent process, and independent in-memory service stores. Its signed
audiences are canonical HTTPS origins, but loopback demo transport is HTTP;
do not copy that exception into a deployed service. It submits directly to
EntryPoint, not through a bundler. Restarting the Hardhat node clears deployments.
See [the local demo guide](docs/LOCAL-DEMO.md) for the complete flow.

For manual owner management and policy editing, the full owner portal remains available separately via `npm run build:portal` and `npm run serve:portal`. Configure trusted deployment addresses in [`portal/config.ts`](portal/config.ts) first. It is not started by `npm run demo`; identity creation does not require it.

To run the separate, SDK-backed Service A page, build it with `npm run build:demo-service` and start `npm run serve:demo-service` against the same local node. It prints a one-time operator key for the page. Grant and revoke report/compute access, then retry with the same agent session; see the [hands-on guide](docs/SERVICE-DEMO.md).

The contract ABI and typed-data details are documented in the [protocol](docs/PROTOCOL.md).

## Security

Do not commit private keys, seed phrases, access tokens, or populated environment files.
Use placeholder values in any `.env.example` files.
