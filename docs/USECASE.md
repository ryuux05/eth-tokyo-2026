# Agentic World use cases (v0)

An agent authenticates as a persistent `0xAGENT` smart account, without receiving the human's OAuth token, API key, or session. A human creates the account through `AgentAccountFactory`, which records the transaction sender as immutable `owner()` and installs a separate operating signer. The [protocol](PROTOCOL.md) specifies proof verification; the [implementation plan](IMPLEMENTATION.md) distinguishes local code from the live demo still to build.

## 1. Access a resource already paid for by the owner

A human has linked wallet `0xHUMAN` to Service A and paid for `dataset.read`. They want their agent to fetch data without impersonating them.

1. The owner wallet calls `AgentAccountFactory.createAgent(authenticator, salt)`, creating `0xAGENT` with `owner() = 0xHUMAN`.
2. The operating key signs the exact dataset request. Service A pins the v0 account implementation, verifies the clone and ERC-1271 proof, checks expiry, and atomically consumes the nonce.
3. If Service A chooses `owner` association, it reads `owner()` from that verified account and maps `0xHUMAN` to its locally verified customer. It may instead require `manual` enrollment of this particular agent.
4. Service A checks its **own** active subscription, agent-eligible route, and any extra approval rules before returning `dataset.read`.

Owner association can make access convenient, but it does not automatically inherit every human permission. Service A may allow reads while excluding writes, billing changes, and account deletion. Another service can make a different decision for the same agent and owner.

**Acceptance:** a valid proof, required association, active entitlement, and agent-eligible route succeed; any missing condition denies the resource.

## 2. Use one identity across two independent services

The agent signs a separate request for Service A and Service B. Each checks `0xAGENT.isValidSignature(...)` against the shared account state, but keeps its own nonce store, sessions, users, subscriptions, and route policy. Neither calls an Agentic World authentication backend or trusts the other service's session.

**Acceptance:** the same agent authenticates at both; a Service A proof fails at Service B because the signed audience differs. Access granted by one service does not imply access at the other.

## 3. Grant paid access directly to the agent

A service may recognize `0xAGENT` without linking it to a human user. If the service offers an agent-specific purchase, it records the resulting scope and expiry against that agent ID in **its own database**. The agent can reauthenticate while that service-local grant remains active.

**Acceptance:** an authenticated but unpaid agent is denied; after payment it gets only the purchased scope until the local grant expires. The payment and entitlement integration remains to be built in the live service demo.

## 4. Rotate or revoke the operating key

If a KMS-backed signer is replaced or compromised, the owner calls `rotateAuthenticator` or `revokeAuthenticator` on `0xAGENT`. The agent address and owner remain unchanged. Revocation stops new request proofs and UserOperation signatures once verification observes the updated chain state. The owner can restore a signer later.

**Acceptance:** the old key cannot start a new authenticated session after rotation/revocation; the new or restored key can. A previously issued service session may survive until its short expiry unless that service performs an immediate onchain recheck or invalidates it locally.

## 5. Make a bounded onchain purchase

The owner sets a default-deny execution policy through the portal. For the narrow demo action `purchaseCompute(address,uint256)` on a pinned target, a 2-token call can match an autonomous `ALLOW` rule while a 20-token call can require an exact owner signature. The operating signer signs an ERC-4337 UserOperation; the fixed ERC-7579 `AgentPolicyHook` checks the action before execution and token spend afterward. The service separately decides whether that purchase earns any resource entitlement.

**Acceptance:** the small call succeeds under its rule; the larger call needs an owner approval bound to that exact action, policy revision, nonce, deadline, agent, and chain; an unapproved or overcharged call fails. These are per-call limits, not a cumulative budget or a universal token-spending guard. Local tests cover the hook behavior and one allowed operation through EntryPoint v0.8; a bundler and live payment service are still outstanding.

## What these cases do not promise

- No global permission, subscription, or behavioral-mandate registry. Services remain responsible for resource authorization.
- No automatic grant of all human privileges merely because `owner()` resolves to a paid user.
- No proof that a black-box agent follows its human's instructions.
- No transfer of a human's login credentials to the agent.
- No immediate invalidation of existing service sessions without an explicit service-side freshness mechanism.
- No in-place upgrade of an existing immutable v0 clone to future execution code at the same address.
