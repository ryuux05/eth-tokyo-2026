# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

Read the [protocol design](docs/PROTOCOL.md) for the authentication flow and trust boundaries, and the [use cases](docs/USECASE.md) for concrete service behavior.

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
- An agent signing client and reusable service-side verification middleware.
- Two independent services recognizing the same agent with different local permissions.
- A demonstration of mandate-backed access to a selected resource paid for by the
  principal, with other principal privileges still restricted.

Services verify proofs and relevant onchain identity state without depending on
an Agentic World-hosted authentication backend. They retain responsibility for
their own access policies, challenge consumption, rate limits, and billing.

A global permission registry, onchain service ACLs, and universal payment policies
are not part of the core identity protocol.

## Status

Design and initial repository scaffold. The features above are planned;
no application or contracts have been implemented in this repository yet.

Development instructions, architecture, tests, and demo details will be added as the project takes shape.

## Security

Do not commit private keys, seed phrases, access tokens, or populated environment files.
Use placeholder values in any `.env.example` files.
