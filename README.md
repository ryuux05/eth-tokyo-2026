# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

**Architecture freeze:** Agentic World v0 uses an ERC-4337 / ERC-7579 smart
account, an `AgentValidator` for operating-key authentication and ERC-1271, and an
`AgentPolicyHook` plus `PolicyEngine` for owner-controlled onchain execution.
The protocol lets services verify signed HTTP requests independently and keep their own
authorization rules, with manual or `owner()`-derived agent association. See the
[v0 architecture](docs/ARCHITECTURE-v0.md). MCP request canonicalization and
EIP-8141 + ERC-8286 are future work, **not** part of v0.

Start with the [current implementation](docs/V0-IMPLEMENTATION.md),
[architecture](docs/ARCHITECTURE-v0.md), [owner portal guide](docs/PORTAL.md),
and [design system](DESIGN.md). The [protocol](docs/PROTOCOL.md),
[policy](docs/POLICY.md), [Core SDK](docs/CORE-SDK.md), [service SDK](docs/SDK.md),
and [implementation plan](docs/IMPLEMENTATION.md) describe the current v0 path.
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

This is **not yet a deployed, end-to-end network demo**. A local integration test
uses the official EntryPoint v0.8 contract to execute a signed UserOperation,
then authenticates the same agent through the service SDK. It does not use a bundler. There is
no deployed factory address, live KMS adapter, HTTP service, durable nonce/session
store, or canonical MCP request format. Only the single-call, revert-on-error
ERC-7579 execution mode is enabled; all onchain actions are default-denied until
the owner installs a policy. See the [implementation status and security limits](docs/V0-IMPLEMENTATION.md).

To run the checks:

```sh
npm install
npm run build
npm test
npm run typecheck
```

To build and serve the owner page locally, run `npm run build:portal` and `npm run serve:portal`. Before wallet transactions, set trusted deployment addresses in [`portal/config.ts`](portal/config.ts).

The contract ABI and typed-data details are documented in the [protocol](docs/PROTOCOL.md).

## Security

Do not commit private keys, seed phrases, access tokens, or populated environment files.
Use placeholder values in any `.env.example` files.
