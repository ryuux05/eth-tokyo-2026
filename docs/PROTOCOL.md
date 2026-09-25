# Agentic World protocol

Agents need to act under a user's authority without becoming the user. Giving an agent the user's OAuth token, API key, or session collapses the distinction between principal and agent. Agentic World gives the agent its own persistent Ethereum identity and lets independent services recognize it as acting under a user-approved mandate.

This document describes the protocol intended for the ETHGlobal Tokyo 2026 prototype. The handoff's unresolved choices remain open where marked below.

## Responsibility boundary

The protocol separates three facts:

1. **Agent identity:** `0xAGENT` proves who is making the request.
2. **User mandate:** `0xHUMAN` explicitly approves that agent to act on their behalf, proven independently of the agent's self-reported `owner()` value. The mandate establishes the relationship; it is not the human's login or a blanket resource grant.
3. **Service authorization:** Each service decides which requests, if any, that mandated agent may make using its own customer accounts, subscriptions, and access policy.

Ethereum and the agent account provide a shared identity and a way to check current authentication authority. A portable mandate can prove the principal–agent relationship to independent services. A service may grant access directly to `0xAGENT` or permit mandate-backed requests for selected resources already available to the principal. Services maintain their own registration, access rules, challenge records, payments, and sessions. They can verify the agent and mandate without an Agentic World authentication server.

The account also governs actions initiated *from the agent account*, such as token payments. That execution policy is separate from a service's resource access policy.

## Identity and keys

```text
0xAGENT root EOA key  ── EIP-7702 delegation ──> AgentAccount at 0xAGENT
                                                  ├── owner: human/org controller
                                                  └── authenticator: operating signer
```

- `0xAGENT` is the stable public identity. Rotating the operating signer does not change it.
- The root EOA key retains ultimate authority to change or clear EIP-7702 delegation. The agent runtime must not hold it.
- The owner controls lifecycle operations inside the delegated account, including rotating or revoking the authenticator.
- The authenticator signs routine authentication proofs. Its private key may be held by AWS KMS. It cannot manage identity lifecycle or loosen execution policy.

EIP-7702 delegation does not initialize account storage. Bootstrap must be one-time and authorized by the root EOA key; an unauthenticated, first-caller-wins initializer is unsafe. Because services may accept mandate-backed requests, naming a human or organization as owner must also require that principal's explicit, verifiable approval. Root authorization alone cannot prove the named principal agreed. The exact bootstrap transaction and signatures remain an open design decision. [EIP-7702 security considerations](https://eips.ethereum.org/EIPS/eip-7702#front-running-initialization)

### Agent creation and bootstrap

```mermaid
sequenceDiagram
    autonumber

    participant H as Human / Owner
    participant A as 0xAGENT EOA
    participant C as AgentAccount
    participant K as KMS / Authenticator
    participant E as Ethereum

    H->>A: Create 0xAGENT
    Note over A: Persistent Agent ID

    H->>K: Create operating signing key
    K-->>H: Public key
    H->>H: Derive 0xAUTHENTICATOR

    H->>A: Authorize EIP-7702 delegation
    A->>E: Delegate to AgentAccount implementation

    Note over A,C: 0xAGENT now executes<br/>AgentAccount code via EIP-7702

    H->>A: Initialize identity
    Note over H,A: owner = 0xHUMAN<br/>authenticator = 0xAUTHENTICATOR
    H->>H: Sign mandate for 0xAGENT

    A->>C: Execute initialize(...)
    C->>C: Verify root authorization and owner consent
    C->>C: Store owner
    C->>C: Store authenticator
    C->>C: Store createdAt
    C->>C: Mark initialized

    Note over A: 0xAGENT is ready

    H->>K: Grant agent runtime signing access
```

The diagram separates the agent address from its delegated implementation for readability. Delegated code runs in `0xAGENT`'s account context, so the initialized storage belongs to `0xAGENT`. `initialize(...)` must check both root authorization and the named owner's mandate before setting owner and authenticator. But a service **cannot infer historical consent from the current implementation and `owner()` alone**: the root key could temporarily delegate to other code, write a false owner into persistent storage, and switch back. Before mandate-backed access, the service must independently verify the principal's approval, such as an owner-signed mandate for this agent and chain, or an owner-authorized record in a shared onchain registry. The exact proof, expiry, and revocation format remain open. [EIP-7702 storage management](https://eips.ethereum.org/EIPS/eip-7702#storage-management)

## Reference authentication handshake

```text
Service generates and stores a random, single-use challenge
  → Agent builds an AgentAuthentication message for that service
  → Agent computes its EIP-712 digest
  → Operating key signs the digest, optionally through KMS
  → Agent sends the message and signature to the service
  → Service validates the message against its challenge
  → Service computes the digest itself
  → Service encodes the signed fields with the operating-key signature
  → Service calls 0xAGENT.isValidSignature(digest, encodedSignature) via eth_call
  → Account returns 0x1626ba7e only for a valid current authenticator
  → Service atomically consumes the challenge and creates a short session
  → Service applies its own access rules to resource requests
```

### First connection, authentication, and session

```mermaid
sequenceDiagram
    autonumber

    participant A as Agent
    participant K as KMS / Authenticator
    participant S as Service
    participant E as Ethereum / 0xAGENT

    A->>S: Connect(agentId = 0xAGENT)

    S->>E: Resolve 0xAGENT and optional mandate
    E-->>S: AgentAccount / owner() / signed mandate / protocol support
    S->>S: If presented, verify mandate before trusting owner()

    S->>S: Generate random nonce
    S->>S: Store challenge as unused

    S-->>A: Authentication challenge
    Note over A,S: audience<br/>nonce<br/>issuedAt<br/>expiresAt

    A->>A: Construct EIP-712 AgentAuthentication
    Note over A: agentId = 0xAGENT<br/>audience = Service<br/>nonce = challenge<br/>issuedAt<br/>expiresAt

    A->>K: Sign EIP-712 digest
    K-->>A: Signature

    A->>S: AgentAuthentication + signature

    S->>S: Validate audience
    S->>S: Validate nonce
    S->>S: Validate timestamps
    S->>S: Validate agentId / chain
    S->>S: Recompute digest and encode signed fields with signature

    S->>E: eth_call<br/>0xAGENT.isValidSignature(digest, encodedSignature)

    E->>E: ERC-1271 validation
    Note over E: Recover/check current<br/>operating authenticator

    E-->>S: 0x1626ba7e (VALID)

    S->>S: Atomically consume nonce
    S->>S: Generate random session token
    S->>S: Store H(token) → agentId, optional principal, expiry
    S-->>A: Session token (~60 sec)

    Note over A,S: Authentication complete
```

The service constructs the EIP-712 domain with its expected `chainId` and `verifyingContract = agentId`. The `encodedSignature` call argument is the service's proposed packaging of the signed fields and operating-key signature described below.

The agent sends this proof to the service:

```text
{
    agentId     // 0xAGENT
    audience    // the intended service
    nonce       // the service's challenge
    issuedAt
    expiresAt
    signature   // operating-key ECDSA signature, sent alongside the signed data
}
```

The EIP-712 digest covers the `AgentAuthentication` fields below. The signature is the result of signing that digest; it is not itself a field inside the signed struct.

```text
EIP712Domain {
    name
    version
    chainId
    verifyingContract = agentId
}

AgentAuthentication {
    agentId
    audience
    nonce
    issuedAt
    expiresAt
}
```

The service builds the domain from its expected chain and the challenge-bound `agentId`, then recomputes the digest. It does not trust domain fields or a digest supplied by the agent. The exact type string, domain name/version, audience encoding, timestamp units, and clock skew allowance must be frozen before implementation. [EIP-712](https://eips.ethereum.org/EIPS/eip-712)

### What each verifier checks

The service generates an unpredictable challenge, preferably 256 bits, and stores it with the expected agent, audience, expiry, and consumption state. If the agent is new to the service, the service binds the claimed `agentId` to that challenge when it issues it.

Before `eth_call`, the service checks:

1. `agentId` equals the agent bound to its challenge; this is the `0xAGENT` it will call.
2. The EIP-712 domain's `verifyingContract` equals `agentId`.
3. The EIP-712 domain's `chainId` equals the service's expected chain.
4. `audience` equals this service's configured audience.
5. `nonce` exists in the service's challenge store, is unused, and is still within the challenge's lifetime.
6. `issuedAt` is within the service's allowed time window, and `expiresAt` has not passed.

The service recomputes the digest from those verified fields and the expected domain. A valid ERC-1271 result is followed by atomic challenge consumption and session issuance.

The service must also establish that `0xAGENT` currently exposes the expected Agentic World authentication behavior. For mandate-backed access, it must separately verify the principal's mandate; current code recognition cannot by itself prove that historical storage writes were authorized. The precise version/discovery mechanism is still open. A claimed version or ERC-165 response alone is not a security guarantee about arbitrary account code.

The account's ERC-1271 method checks the digest and signature against its current authentication policy. On success it returns the standard magic value `0x1626ba7e`. The method is read-only; it cannot consume the service's challenge. The service therefore consumes the challenge atomically after successful verification, so two concurrent submissions cannot create two sessions from one nonce. [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271)

The return value means the account accepts **this signature for this digest in the current onchain state**. It does not mean the service's nonce is fresh, the audience is correct, or the agent has permission to use a resource. Those checks belong to the service.

### Restrict what the operating key can sign for

This restriction is especially important because v3 also gives the account an execution policy. A generic `isValidSignature(hash, rawOperatingSignature)` implementation would accept any digest signed by the operating key. Another application that accepts ERC-1271 signatures could then treat that key as a broader wallet signer, bypassing the intended account execution boundary.

For the prototype, the service should encode the signed `AgentAuthentication` fields together with the received operating-key ECDSA signature as the ERC-1271 `signature` argument. The account recomputes the allowed typed digest using its own address as `verifyingContract` and the expected chain ID, requires it to equal the supplied `hash`, checks that the authenticator is active, and only then validates the ECDSA signature. The service still verifies its own audience, challenge, and time rules. This encoding is a proposed resolution of the open signature-format decision; it needs a concrete test against other ERC-1271 consumers before the ABI is frozen.

Owner approvals for account actions use a **separate** typed message and replay nonce. The operating authenticator's authentication proof must never double as an owner approval.

### KMS signing

When AWS KMS signs an already computed EIP-712 digest, its request must use `MessageType: DIGEST` to avoid hashing the digest again. KMS returns an ECDSA signature in DER format; the agent signer adapts it to the signature format expected by the account and handles low-s normalization and recovery parity correctly. KMS protects key custody, but a compromised runtime that may call `kms:Sign` can still request signatures until that access is removed. [AWS KMS Sign API](https://docs.aws.amazon.com/kms/latest/APIReference/API_Sign.html)

### Session and revocation semantics

A successful handshake may produce a short-lived, opaque service-local session. A 60-second lifetime is a demo default, not a protocol rule. The service may cache a *mandate-verified* principal address with the agent ID in that session. The token is a cached authentication result, not the agent's identity, mandate, or a grant of resource access; the service checks its own policy and the principal's current service-side entitlement on use.

### Requests after session creation

```mermaid
sequenceDiagram
    autonumber

    participant A as Agent
    participant S as Service
    participant DB as Service DB
    participant R as Resource

    A->>S: Request + AgentSession token

    S->>S: Hash token
    S->>DB: Lookup session

    DB-->>S: agentId = 0xAGENT<br/>verifiedPrincipal = 0xHUMAN or none<br/>expiresAt

    S->>S: Check session expiry

    alt Session valid
        S->>DB: Lookup direct grant for 0xAGENT
        DB-->>S: Direct grant or none
        S->>DB: If mandated, check principal's account and paid entitlement
        DB-->>S: Active principal entitlement or none
        S->>S: Apply service policy for mandate-backed requests

        alt Direct or mandate-backed access allowed
            S->>R: Execute requested operation
            R-->>S: Result
            S-->>A: 200 Result
        else Permission missing
            S-->>A: PERMISSION_REQUIRED / DENIED
        end

    else Session expired
        S-->>A: SESSION_EXPIRED
    end
```

Rotating or revoking the authenticator blocks *new* authentication once the service observes the changed chain state. An existing session may remain usable until its expiry unless the service checks an authentication epoch or another revocation signal on each request. Immediate invalidation is an open product decision; the prototype must describe whichever behavior it implements. The root EOA can also change delegated code, so services must not treat a prior verification as a permanent guarantee about current account behavior.

## User mandate and service authorization

After authenticating `0xAGENT`, a service can check a direct local grant for that agent. Alternatively, it can verify a user mandate, match its principal `0xHUMAN` to an existing paid or registered account, and permit the agent to request selected resources on that principal's behalf. The service must explicitly mark those resources as eligible for mandated agents. Neither agent authentication nor the mandate alone grants resource access, and the agent never receives the human's credential.

For example, Service A has already verified that `0xHUMAN` controls its registered address and has an active paid `dataset.read` entitlement. On first connection, Service A authenticates `0xAGENT`, reads `owner() = 0xHUMAN`, and verifies `0xHUMAN`'s mandate for that exact agent and chain. On a dataset request, it checks that the paid entitlement is still active and that its own policy permits mandated agents to request `dataset.read`. It may then serve the data under the agent's *own* short-lived session. Service A can still require a direct agent grant or fresh human approval for `billing.manage`, destructive writes, or any other excluded operation. Service B can make a different choice using the same agent identity and mandate.

This feature depends on two independent facts: the principal genuinely mandated this agent, and the service intentionally allows the particular request. Neither a self-reported `owner()` nor a pinned current implementation proves the mandate, because another delegate could previously have modified the same storage. A service must verify an owner-signed mandate or an owner-authorized onchain registry record independently of mutable agent storage. The exact mandate-proof and revocation formats remain open. Owner changes must invalidate or bound any cached mandate; a short session only bounds that staleness, while sensitive access may require a fresh onchain check.

### Candidate user-mandate proof for the prototype

The simplest portable option is a **one-time EIP-712 mandate signed by the human owner**, separate from the operating authenticator's `AgentAuthentication` proof:

```text
EIP712Domain {
    name = "Agentic World Mandate"
    version = "1"
    chainId = expected chain
    verifyingContract = 0xAGENT
}

AgentMandate {
    agentId:    0xAGENT
    principal:  0xHUMAN
    issuedAt:   Unix seconds
    expiresAt:  Unix seconds
}

mandateSignature = signature by 0xHUMAN over this typed digest
```

The mandate means: “I recognize this agent as acting on my behalf and permit it to request agent-eligible resources.” It does **not** authorize account spending, transfer the principal's session, or compel any service to grant access. The signature intentionally has **no service audience** so independent services can verify the same mandate; a service can require additional service-specific approval for sensitive access. The agent account can expose the signed fields and signature through a read-only method, but an untrusted agent can also transmit them; neither location makes the claim true. At authentication, each service SDK must reconstruct the digest from its expected chain and challenged `agentId`, check `owner()` matches the signed `principal`, check the validity window, and independently verify that the principal address signed it. For an EOA principal this means recovering the ECDSA signer; contract-wallet principals would require a separate ERC-1271 path. The signed `agentId` and domain's `verifyingContract` must both equal the challenged agent.

Only after that check may the SDK expose the address as a *mandate-verified principal* and let service code use it for mandate-backed access. Its session must expire no later than the mandate. Reusing the same signature at multiple services is intentional; replay **after withdrawal but before expiry** remains a risk. A short expiry bounds that risk for the demo, while immediate cross-service revocation needs additional principal-controlled onchain state, such as a mandate registry. The format and revocation design above are a candidate, not yet a finalized ABI.

## Per-request authentication

A service may require a fresh signature for each request or for selected sensitive actions. That message must additionally bind the HTTP method, canonical path, body hash, and a fresh replay value. The session establishment message above does not need request fields. Per-request signing is optional for the hackathon prototype.

## Account execution policy

The delegated account can enforce which account actions the operating signer may initiate alone and which require an owner signature. The recommended hackathon demonstration is a narrowly defined small payment allowed autonomously and a larger payment requiring an approval bound to the agent, chain, target, value, call data, nonce, and deadline.

The owner alone may change the execution policy and operating authenticator. Approval nonces belong to the account execution protocol; they are separate from service authentication challenges. The exact payment limit and cumulative budget rules are still open. No service-specific permissions or subscriptions belong in the core account.

## Demo acceptance cases

- The same `0xAGENT` authenticates independently to two services using one operating key, without sharing their challenge or session databases.
- A proof issued for Service A fails at Service B; an expired or already consumed challenge fails at Service A.
- The service denies a resource when its local permission is absent, even after successful authentication.
- A registered and paid principal can mandate an agent to request a service-approved resource without giving the agent human credentials; a request excluded by service policy is still denied.
- An agent that merely claims someone else's paid address through an untrusted `owner()` implementation cannot establish that person's mandate.
- After the owner rotates the authenticator, the old key cannot create a new session and the new key can, while `0xAGENT` remains unchanged.
- The operating key cannot approve an owner-only action or expand its own execution limits.

## Decisions still open

The handoff leaves protocol discovery/versioning, secure bootstrap mechanics, independent mandate proof and revocation, the final EIP-712 field types and encoding, optional authenticator expiry and epoch, session lifetime/revocation behavior, and the account execution ABI to be finalized. The proof fields and verification checks above are the expected authentication path; they do not settle those remaining implementation details by implication.
