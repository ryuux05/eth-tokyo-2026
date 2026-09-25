# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

Read the [protocol design](docs/PROTOCOL.md) for authentication and trust boundaries, the [execution policy](docs/POLICY.md) for onchain autonomy limits, the [owner portal guide](docs/PORTAL.md) for registration and policy authoring, the [use cases](docs/USECASE.md), the [SDK guide](docs/SDK.md), and the [implementation plan](docs/IMPLEMENTATION.md).

## Idea

Give an agent a persistent Ethereum account that it can use to authenticate across
services without borrowing a human's login session or access tokens. A separate
user-approved mandate lets services recognize that it acts on someone's behalf.
EIP-7702 provides programmable account behavior, while a human or organization
retains control of the identity and its operating signers.

Identity and mandate are portable; authorization belongs to each service. A service
can choose to let a mandated agent request selected resources already paid for or
registered to its principal. Neither agent authentication nor the mandate alone
grants access to a resource.

## Planned prototype

- An EIP-7702 agent account with owner/controller binding and operating-signer management.
- Single-use, expiring challenges bound to the intended service and request.
- A separate agent signing SDK and service verification SDK.
- Two independent services recognizing the same agent with different local permissions.
- A demonstration of mandate-backed access to a selected resource paid for by the
  principal, with other principal privileges still restricted.

Services verify proofs and relevant onchain identity state without depending on
an Agentic World-hosted authentication backend. They retain responsibility for
their own access policies, challenge consumption, rate limits, and billing.

A global permission registry, onchain service ACLs, and universal payment policies
are not part of the core identity protocol.

## Status

The first onchain milestone, bounded execution policy, and both SDK cores are implemented locally:
`AgentAccount` manages EIP-7702 identity and authenticators, while
`MandateRegistry` records principal-approved mandates. The agent SDK signs
service challenges; the service SDK verifies proofs and issues local sessions.
Tests cover EIP-7702 delegation, authorization flows, owner-defined native and
token-purchase rules, and SDK interoperability. The owner registration/policy
page is built, but needs deployed contract addresses and a bootstrapped agent.
HTTP services, durable storage adapters, KMS integration, and public deployment
are not implemented yet.

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
