# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

**Architecture freeze:** Agentic World v0 uses an ERC-4337 / ERC-7579 smart
account, an `AgentValidator` for operating-key authentication and ERC-1271, and an
`AgentPolicyHook` plus `PolicyEngine` for owner-controlled onchain execution.
The protocol lets services verify signed HTTP requests independently and keep their own
authorization rules, with manual or `owner()`-derived agent association. See the
[v0 architecture](docs/ARCHITECTURE-v0.md). The local MCP now canonicalizes
URL-based requests; EIP-8141 + ERC-8286 remain future work.

Start with the [current implementation](docs/V0-IMPLEMENTATION.md),
[architecture](docs/ARCHITECTURE-v0.md), [owner portal guide](docs/PORTAL.md),
and [design system](DESIGN.md). The [protocol](docs/PROTOCOL.md),
[policy](docs/POLICY.md), [Core SDK](docs/CORE-SDK.md), [service SDK](docs/SDK.md),
and [implementation plan](docs/IMPLEMENTATION.md) describe the current v0 path.
For Codex/Claude Code integration, see the [local MCP server and skills](docs/MCP.md).
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
- Request-bound, expiring signatures with single-use agent-generated nonces; a
  service-issued challenge path remains available.
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
no deployed factory address, live KMS adapter, persistent HTTP service, durable nonce/session
store. The local MCP has a URL-based request format and a macOS Secure Enclave
signer adapter; physical-key provisioning and signing have not yet been exercised
end-to-end in this repository. Only the single-call, revert-on-error
ERC-7579 execution mode is enabled; all onchain actions are default-denied until
the owner installs a policy. See the [implementation status and security limits](docs/V0-IMPLEMENTATION.md).

To run the checks:

```sh
npm install
npm run build
npm test
npm run typecheck
```

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
service-local admin denial (403), nonce replay rejection (401), and fresh-proof
rejection at both services after onchain key revocation (401/401). It uses
publicly known Hardhat owner keys, an ephemeral operating key passed only to
the demo agent process, and independent in-memory service stores. Its signed
audiences are canonical HTTPS origins, but loopback demo transport is HTTP;
do not copy that exception into a deployed service. It submits directly to
EntryPoint, not through a bundler. Restarting the Hardhat node clears deployments.
See [the local demo guide](docs/LOCAL-DEMO.md) for the complete flow.

To build and serve the owner page locally, run `npm run build:portal` and `npm run serve:portal`. Before wallet transactions, set trusted deployment addresses in [`portal/config.ts`](portal/config.ts).

The contract ABI and typed-data details are documented in the [protocol](docs/PROTOCOL.md).

## Security

Do not commit private keys, seed phrases, access tokens, or populated environment files.
Use placeholder values in any `.env.example` files.
