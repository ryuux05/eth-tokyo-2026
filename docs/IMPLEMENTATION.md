# Agentic World implementation plan

This is the repository's working build plan. The [use cases](USECASE.md) describe the desired behavior; the [protocol](PROTOCOL.md) describes the trust boundaries. The v3 handoff includes an older `IMPLEMENTATION_PLAN.md`, but this plan also accounts for the newer user-mandate discussion.

Current status: the first `AgentAccount` and `MandateRegistry` implementations and local EIP-7702 tests are in the repository. They are not deployed or audited; SDK and independent-service integration remain to be built.

## Contract-first milestone

1. Deploy one `AgentAccount` implementation. A persistent `0xAGENT` EOA delegates to it using EIP-7702. Services must call account methods at `0xAGENT`, not at the implementation address, because the storage belongs to the agent address.
2. Bootstrap the account in a transaction sent directly by the human owner. `initialize` sets `owner = msg.sender`, but also requires a one-time authorization signed by the `0xAGENT` root key and bound to the agent, owner, authenticator, chain, and deadline. `msg.sender` alone is vulnerable to first-caller initialization.
3. Implement owner-only authenticator rotation, revocation, and restoration. The operating signer can authenticate but cannot manage lifecycle state.
4. Implement ERC-1271 `isValidSignature` for *only* the protocol's EIP-712 `AgentAuthentication` message. Raw operating-key signatures over arbitrary digests must not be accepted.
5. Deploy a separate `MandateRegistry`. The human calls `register(agent, agentRootPermit)` directly, so the registry records `principal = msg.sender`. A root-signed permit prevents registration of someone else's agent. Only the recorded principal can revoke. This onchain record is independent of mutable EIP-7702 account storage.
6. Test EIP-7702 delegation, direct-owner initialization, front-running resistance, ERC-1271 validation, key rotation/revocation, owner registration, and revocation. Do not deploy to a public network before these tests pass.

The registry is **not** a global permission or subscription system. It only records who mandated a particular agent. Each service retains its own paid-account lookup and rule for which resources a mandated agent may request.

## SDK verification milestone

The service SDK will be configured with expected implementation and registry addresses *per chain*. It checks the EIP-7702 delegation pointer of `0xAGENT`, calls `0xAGENT.isValidSignature(...)`, and reads `0xAGENT.owner()` plus `MandateRegistry.principalOf(0xAGENT)`. It exposes a verified principal only when the registry record is active and matches the account's owner. Calling `owner()` directly on the implementation would read the wrong storage. Current-implementation pinning alone does not prove historical owner consent.

The SDK then handles service challenges, EIP-712 digest construction, atomic nonce consumption, and short-lived sessions. A service can authenticate an agent without a mandate for direct agent-specific grants; it must not convert an unverified owner hint into mandate-backed access.

## Service and demo milestone

Two separate service processes independently verify the same `0xAGENT`. One demonstrates mandate-backed use of a paid principal's selected read entitlement; the other demonstrates a different local policy. A service checks its own paid status and resource policy on use. The agent never receives the human's OAuth token, API key, or session.

## Deferred from the first contract milestone

- Account execution/payment policy and owner-approved high-value actions.
- KMS signer integration; use a local development signer behind the same interface first.
- Immediate invalidation of existing service sessions after onchain changes.
- Contract-wallet principals and relayed registration. With a relayer, `msg.sender` is the relayer, so the registry would need a principal-signed permit instead.
- Owner transfer, universal service permissions, metadata, and reputation.

## Decisions to freeze before SDK integration

The final EIP-712 type strings and signature envelope, audience canonicalization, onchain contract versioning, deployment addresses, session freshness rules, and registration/initialization permit nonces must be documented with executable vectors. The first contract milestone may choose concrete values for testing, but they remain prototype protocol choices until the SDK is built against them.
