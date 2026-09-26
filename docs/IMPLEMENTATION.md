# Agentic World implementation plan

This is the repository's working build plan. The [use cases](USECASE.md) describe the desired behavior; the [protocol](PROTOCOL.md) describes the trust boundaries. The v3 handoff includes an older `IMPLEMENTATION_PLAN.md`, but this plan also accounts for the newer user-mandate discussion.

Current status: the `AgentAccount` and `MandateRegistry` implementations, constrained native/token-purchase policy, separate agent/service SDK cores, owner registration page, and local EIP-7702 tests are in the repository. They are not deployed or audited; HTTP services, durable stores, production agent bootstrap, and KMS integration remain to be built.

## Build order

| Order | Layer | Current state | Completion gate |
| --- | --- | --- | --- |
| 1 | Contract | Implemented and tested locally | Freeze ABI, deploy to a supported test chain, verify addresses. |
| 2 | Core SDK | Implemented as `agentic-world/core` | Keep contract ABIs, typed data, policy schema, and delegation checks interoperable with deployments. |
| 3 | Service SDK + Agent SDK | Working protocol cores | Add durable service adapters and an agent signer/transport integration. |
| 4 | Dashboard | Owner registration and policy page exists | Connect to pinned deployment; complete safe agent bootstrap UX and end-to-end owner flow. |
| 5 | Service A | Not started | Verify agent/mandate and enforce one local paid principal entitlement. |
| 6 | Service B | Not started | Independently verify the same agent with a different local policy. |
| 7 | Demo Agent | Not started | Drive both service flows and the 2/20 token-purchase policy demonstration. |

Each layer depends on the stable interface below it. The UI can be developed locally before public deployment, but it must not present unconfigured contracts as a live registration flow. Service A and B do not share challenge, session, or permission databases.

## Contract-first milestone

1. Deploy one `AgentAccount` implementation. A persistent `0xAGENT` EOA delegates to it using EIP-7702. Services must call account methods at `0xAGENT`, not at the implementation address, because the storage belongs to the agent address.
2. Bootstrap the account in a transaction sent directly by the human owner. `initialize` sets `owner = msg.sender`, but also requires a one-time authorization signed by the `0xAGENT` root key and bound to the agent, owner, authenticator, chain, and deadline. `msg.sender` alone is vulnerable to first-caller initialization.
3. Implement owner-only authenticator rotation, revocation, and restoration. The operating signer can authenticate but cannot manage lifecycle state.
4. Implement ERC-1271 `isValidSignature` for *only* the protocol's EIP-712 `AgentAuthentication` message. Raw operating-key signatures over arbitrary digests must not be accepted.
5. Deploy a separate `MandateRegistry`. The human calls `register(agent, agentRootPermit)` directly, so the registry records `principal = msg.sender`. A root-signed permit prevents registration of someone else's agent. Only the recorded principal can revoke. This onchain record is independent of mutable EIP-7702 account storage.
6. Test EIP-7702 delegation, direct-owner initialization, front-running resistance, ERC-1271 validation, key rotation/revocation, owner registration, and revocation. Do not deploy to a public network before these tests pass.

The registry is **not** a global permission or subscription system. It only records who mandated a particular agent. Each service retains its own paid-account lookup and rule for which resources a mandated agent may request.

The owner sets a versioned ABI policy on `0xAGENT`. `PolicyEngine` evaluates target, selector, native value, and—only for the fixed `purchaseCompute(address,uint256)` ABI—token and amount in first-match order, with explicit `DENY`, `ALLOW`, and `REQUIRE_OWNER_SIGNATURE` outcomes. The operating authenticator alone may call `execute`, and only the current owner may change policy. Owner approvals bind the exact action, current policy hash and revision, nonce, deadline, agent, and chain. The [policy guide](POLICY.md) documents format, limitations, and root-key trust assumptions. Hardhat EIP-7702 tests cover policy enforcement, 2/20 demo-token thresholds, and both EOA and ERC-1271 owners.

## Core SDK milestone

[`agentic-world/core`](CORE-SDK.md) is the shared protocol dependency. It exposes the tested ABIs, EIP-712 typed-data builders, ERC-1271 proof encoding, EIP-7702 pointer check, and policy encoder/decoder. It does not sign, issue sessions, own permission data, or introduce a central authentication backend. The agent and service SDKs import this core rather than duplicating protocol formats.

## Service SDK + Agent SDK milestone

The service SDK will be configured with expected implementation and registry addresses *per chain*. It checks the EIP-7702 delegation pointer of `0xAGENT`, calls `0xAGENT.isValidSignature(...)`, and reads `0xAGENT.owner()` plus `MandateRegistry.principalOf(0xAGENT)`. It exposes a verified principal only when the registry record is active and matches the account's owner. Calling `owner()` directly on the implementation would read the wrong storage. Current-implementation pinning alone does not prove historical owner consent.

The service SDK then handles service challenges, EIP-712 digest construction, atomic nonce consumption, and short-lived sessions. A service can authenticate an agent without a mandate for direct agent-specific grants; it must not convert an unverified owner hint into mandate-backed access. Storage is injected by each service; the SDK does not provide a shared backend or a production database.

The separate agent SDK validates the challenge against its configured agent ID, chain, and expected audience, then asks an injected signer to sign the digest. It does not hold the root EOA key or a human session. See the [SDK guide](SDK.md) for the frozen wire choices and integration examples.

## Dashboard milestone

The [owner portal](PORTAL.md) verifies an existing agent, edits ordered rules, submits `setPolicy`, previews saved policy via `eth_call`, and registers the mandate using an agent-root permit signed outside the page. It needs pinned contract addresses and a separate agent bootstrap workflow before a live end-to-end demonstration.

## Service A milestone

Service A independently verifies `0xAGENT`, checks a registered principal's active paid entitlement, and permits only a service-selected agent-eligible resource. It retains its own challenge, session, account, billing, and ACL state.

## Service B milestone

Service B independently verifies the same `0xAGENT` and uses a different local permission rule. It never trusts Service A's sessions or payments. Its purchase endpoint is the pinned target for the narrow token policy demonstration.

## Demo Agent milestone

The demo agent answers two independent service challenges with its operating signer, makes an autonomous 2-token purchase, requests an exact owner approval for a 20-token purchase, and demonstrates denial of an excluded service route. It never receives the human's OAuth token, API key, or session.

## Deferred from the first contract milestone

- General ERC-20 amount-aware and cumulative spending limits; v1 supports only the explicit demo purchase ABI and per-call ceilings.
- Public deployment, production bootstrap, root-key signing UX, and live $2/$20 service demo. Local contract tests and the owner page exist.
- KMS signer integration; use a local development signer behind the same interface first.
- Immediate invalidation of existing service sessions after onchain changes.
- Contract-wallet principals and relayed registration. With a relayer, `msg.sender` is the relayer, so the registry would need a principal-signed permit instead.
- Owner transfer, universal service permissions, metadata, and reputation.

## Decisions to freeze before SDK integration

The contract and SDK now share the EIP-712 type strings and signature envelope, and use canonical HTTPS origins for audiences. Interoperability tests exercise them against the local EIP-7702 account. Onchain versioning, deployment addresses, immediate session invalidation, production storage adapters, and broader token-action semantics remain open.
