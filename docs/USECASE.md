# Agentic World use cases

Agentic World lets an agent authenticate as a persistent `0xAGENT` across independent services and present a user-approved mandate without becoming that user. The mandate establishes who the agent acts for; each service still decides what it may do. Ethereum supplies shared identity and verifiable control facts; each service retains its own accounts, subscriptions, resource permissions, challenges, and sessions. See the [protocol](PROTOCOL.md) for the authentication handshake and trust boundaries.

## 1. Request a resource already paid for by the principal

**Situation:** A human has verified wallet `0xHUMAN` with Service A and paid for `dataset.read`. They want their agent to fetch data without giving it their login, API key, or browser session.

**Flow:**

1. The human signs a mandate for the specific `0xAGENT` on the intended chain. A service-verifiable signature or human-authorized onchain record proves this approval.
2. The agent authenticates to Service A with its own operating signer using the challenge and ERC-1271 flow.
3. The service verifies the mandate independently of the agent's mutable account storage, then matches its principal `0xHUMAN` to its existing customer record.
4. The service checks that the principal's subscription is still active **and** that its own policy permits mandated agents to request `dataset.read`.
5. The service serves the resource under an agent-specific, short-lived session. The human's credentials are never shared with the agent.

This can be automatic *after* the principal has approved the mandate. The mandate is standing to request agent-eligible access, not a copy of the human's permissions. For example, Service A may allow paid dataset reads while withholding writes, billing changes, and account deletion. Service B may apply a different policy to the same `0xAGENT` and `0xHUMAN`.

**Acceptance test:** A paid principal plus a valid agent proof and valid mandate gains `dataset.read`; an expired subscription, service-excluded operation, or missing/invalid mandate is denied.

## 2. Authenticate the same agent to two independent services

**Situation:** An agent needs to use Service A and Service B without creating a separate human login or identity at each.

**Flow:** Each service issues its own single-use challenge, verifies the agent's EIP-712/ ERC-1271 proof against Ethereum, and creates its own short session. The services have separate challenge stores, session stores, and access policies; neither calls an Agentic World authentication backend.

**Acceptance test:** The same `0xAGENT` succeeds at both services, but a proof for Service A fails at Service B. A grant or subscription in one service does not automatically exist in the other.

## 3. Pay for agent-specific access

**Situation:** An unknown agent has no mandate-backed entitlement but wants temporary access to a resource.

**Flow:** Authentication still establishes `0xAGENT`. The service may offer a local paid grant such as `dataset.read` for ten minutes. Once payment succeeds, it records that entitlement against `0xAGENT` in its own database. The grant may outlive the current authentication session; the agent can reauthenticate without repaying while the grant remains active.

**Acceptance test:** A valid agent with no grant is denied until payment; after payment it can access only the paid scope and only until the local grant expires.

## 4. Rotate the operating signer without changing identity

**Situation:** An authenticator key is compromised or replaced, including a KMS-held key.

**Flow:** The owner rotates the authenticator in the agent account. New challenges validate against the new operating key while `0xAGENT` remains the same. Services decide whether an already-issued short session survives until expiry or requires an additional revocation check.

**Acceptance test:** The old signer cannot start a new session after the rotation is observed; the new signer can. Existing service registration and agent-specific grants remain associated with the same `0xAGENT`.

## 5. Let the agent make a bounded payment

**Situation:** The agent needs to buy the temporary access in use case 3.

**Flow:** The service decides the price and whether payment grants access. Separately, the agent's EIP-7702 account execution policy decides whether the operating signer may spend that amount autonomously or must obtain owner approval. Service resource authorization and account spending authority are distinct decisions.

**Acceptance test:** A small payment within the account's limit can proceed autonomously; an amount above that limit requires owner approval and cannot be authorized by an authentication signature.

## Mandate security boundary

`owner()` is a useful lookup hint, **not by itself proof that the named human approved the agent**. The agent's root EOA can change EIP-7702 delegation; another delegate can write to the same agent storage before switching back to the expected implementation. Therefore, merely pinning the current delegated contract address does not prove how `owner` was set.

For mandate-backed access, the service SDK must verify the principal's approval for the exact agent and chain. The [candidate prototype design](PROTOCOL.md#candidate-user-mandate-proof-for-the-prototype) uses one time-bounded EIP-712 signature from the principal, reusable across services. A shared onchain registry controlled by the principal is an alternative that could support immediate revocation. Until a proof is implemented, the SDK must not label `owner()` as a mandate-verified principal or use it to unlock an existing customer's entitlements. Direct agent grants do not require a mandate.

## What is not promised

- No global permission or subscription registry: services keep their own entitlement data and agent-eligibility rules.
- No universal grant of a human's service privileges to an agent.
- No guarantee of immediate session revocation without an explicit freshness check.
- No transfer of human OAuth tokens, API keys, passwords, or browser sessions to agents.
