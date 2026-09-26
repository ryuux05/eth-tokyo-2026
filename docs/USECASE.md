# Agentic World use cases

> **Architecture note:** The use-case goals remain, but the EIP-7702 bootstrap,
> delegation pin, and account execution details below describe the earlier
> prototype. The [v0 freeze](ARCHITECTURE-v0.md) uses ERC-4337/7579 instead.

Agentic World lets an agent authenticate as a persistent `0xAGENT` across independent services without becoming the human who operates it. A service can associate the agent through its own explicit enrollment (`manual`) or by resolving the pinned agent account's `owner()` (`owner`). Neither mode proves the agent's intent or enforces a behavioral mandate. Each service manages its own mandates, accounts, subscriptions, resource permissions, replay records, and sessions. See the [protocol](PROTOCOL.md) for authentication and trust boundaries.

## 1. Request a resource already paid for by the principal

**Situation:** A human has verified wallet `0xHUMAN` with Service A and paid for `dataset.read`. They want their agent to fetch data without giving it their login, API key, or browser session.

**Flow:**

1. The human directly initializes `0xAGENT`, setting `owner = msg.sender`, with the agent-root bootstrap permit. The root key stays outside the agent runtime.
2. The agent signs its exact dataset request with its operating signer; Service A pins the current account implementation, verifies the proof through ERC-1271, and consumes the request nonce.
3. In `owner` mode, Service A reads `0xAGENT.owner()` at that block and matches `0xHUMAN` to its existing, verified customer record. In `manual` mode, it instead reads its own explicit user-to-agent enrollment.
4. Service A checks its own authority/mandate rules, active subscription, and whether this route permits agents to request `dataset.read`.
5. The service serves the resource under an agent-specific, short-lived session. The human's credentials are never shared with the agent.

This can be automatic in owner mode only when Service A has chosen to trust that association and allow agents for this route. `owner()` is not a copy of the human's permissions or proof that the agent follows their instructions. For example, Service A may allow paid dataset reads while withholding writes, billing changes, and account deletion. Service B may apply a different policy to the same `0xAGENT` and `0xHUMAN`.

**Acceptance test:** A valid agent proof plus Service A's required local association and active paid entitlement gains `dataset.read`; an expired subscription, service-excluded operation, or missing required association is denied.

## 2. Authenticate the same agent to two independent services

**Situation:** An agent needs to use Service A and Service B without creating a separate human login or identity at each.

**Flow:** The agent signs an exact request separately for each service. Each verifies the EIP-712/ERC-1271 proof against Ethereum, atomically consumes its own nonce, and may create a short session. The services have separate nonce stores, session stores, and access policies; neither calls an Agentic World authentication backend. A service-issued challenge remains an alternative handshake.

**Acceptance test:** The same `0xAGENT` succeeds at both services, but a proof for Service A fails at Service B. A grant or subscription in one service does not automatically exist in the other.

## 3. Pay for agent-specific access

**Situation:** An unknown agent has no service entitlement but wants temporary access to a resource.

**Flow:** Authentication still establishes `0xAGENT`. The service may offer a local paid grant such as `dataset.read` for ten minutes. Once payment succeeds, it records that entitlement against `0xAGENT` in its own database. The grant may outlive the current authentication session; the agent can reauthenticate without repaying while the grant remains active.

**Acceptance test:** A valid agent with no grant is denied until payment; after payment it can access only the paid scope and only until the local grant expires.

## 4. Rotate the operating signer without changing identity

**Situation:** An authenticator key is compromised or replaced, including a KMS-held key.

**Flow:** The owner rotates the authenticator in the agent account. New request signatures validate against the new operating key while `0xAGENT` remains the same. Services decide whether an already-issued short session survives until expiry or requires an additional revocation check.

**Acceptance test:** The old signer cannot start a new session after the rotation is observed; the new signer can. Existing service registration and agent-specific grants remain associated with the same `0xAGENT`.

## 5. Let the agent make a bounded payment

**Situation:** The agent needs to buy the temporary access in use case 3.

**Flow:** The service decides the price and whether payment grants access. Separately, the agent's EIP-7702 account execution policy decides whether the operating signer may make that exact native-value call or supported token-purchase call autonomously, needs owner approval, or is denied. Service resource authorization and account spending authority are distinct decisions.

**Acceptance test:** A small payment within the account's limit can proceed autonomously; an amount above that limit requires owner approval and cannot be authorized by an authentication signature.

The [policy specification](POLICY.md) records the exact onchain rule format and owner-approval type. The demo's 6-decimal token can show a 2-token autonomous purchase and a 20-token owner-approved purchase through the fixed `purchaseCompute(address,uint256)` action shape. The owner can set those rules while registering the agent in the [owner portal](PORTAL.md). This is a per-call ceiling, not a cumulative budget or a general ERC-20 spending guard.

## Owner-mode trust boundary

`owner()` is a useful lookup hint, **not by itself proof that the named human approved the agent**. The agent's root EOA can change EIP-7702 delegation; another delegate can write to the same agent storage before switching back to the expected implementation. Therefore, merely pinning the current delegated contract address does not prove how `owner` was set.

`owner()` is set in a direct human transaction with an agent-root permit and cannot be changed through `AgentAccount`'s public API. The SDK pins the current EIP-7702 implementation and reads `owner()` at the same block as signature verification. The root key is outside the agent runtime, but EIP-7702 still allows its custodian to authorize other code that can change the account's storage. Owner mode trusts that this does not happen. A service unwilling to make that assumption can use manual enrollment or require a separate human-signed proof. Neither mode determines or enforces a behavioral mandate. The [historical optional registry](PROTOCOL.md#legacy-optional-onchain-owner-binding-registration) is not required by these SDK modes.

## What is not promised

- No global permission or subscription registry: services keep their own entitlement data and agent-eligibility rules.
- No management or enforcement of an agent's behavioral mandate or model instructions.
- No universal grant of a human's service privileges to an agent.
- No guarantee of immediate session revocation without an explicit freshness check.
- No transfer of human OAuth tokens, API keys, passwords, or browser sessions to agents.
