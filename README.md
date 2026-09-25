# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

Read the [protocol design](docs/PROTOCOL.md) for the authentication flow and trust boundaries.

## Idea

Give an agent a persistent Ethereum account that it can use to authenticate across
services without repeatedly borrowing a human's login session or access tokens.
EIP-7702 provides programmable account behavior, while a human or organization
retains control of the identity and its operating signers.

Identity is shared; authorization belongs to each service. A valid authentication
proof establishes the agent's identity, not permission to access a resource.

## Planned prototype

- An EIP-7702 agent account with parent/controller binding and operating-signer management.
- Single-use, expiring challenges bound to the intended service and request.
- An agent signing client and reusable service-side verification middleware.
- Two independent services recognizing the same agent with different local permissions.
- A demonstration of pre-registered access and optional paid temporary access.

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
