# Core SDK and two role-specific SDKs

The dependency order is `contracts → core → service/agent`. The three entry points share one EIP-712/ABI definition but have different jobs:

| Entry point | Runs with | Responsibility |
| --- | --- | --- |
| `agentic-world/core` | Both SDKs and owner portal | Contract ABIs, typed messages, policy encoding, delegation-pointer check. No signer, sessions, or backend. |
| `agentic-world/agent` | Agent runtime | Check the challenge's agent, chain, audience, and lifetime; sign the digest using an injected signer. |
| `agentic-world/service` | Each independent service | Issue challenges, verify EIP-7702 and ERC-1271, resolve the optional mandate, consume nonces, and issue local sessions. |

Build with `npm run build:sdk`. The package is private for the prototype; entry points resolve to JavaScript and declarations under `dist/sdk`. Each service supplies its own RPC client and storage adapters. There is no Agentic World backend dependency. See the [core contract](CORE-SDK.md) for exactly what belongs in the shared layer.

## Agent SDK

```ts
import { createAgentSdk } from "agentic-world/agent";

const agent = createAgentSdk({
  agentId,
  chainId,
  // Local dev signer. A KMS adapter must sign the digest exactly once and
  // convert its DER result to a 65-byte Ethereum r,s,v signature.
  signDigest: digest => operatingAccount.sign({ hash: digest }),
});

const proof = await agent.answerChallenge(challenge, "https://service-a.example");
// Send proof to that service's authenticate endpoint; keep its session local.
```

The agent SDK does not possess the agent root key or human credentials. The caller passes the expected audience separately, rather than trusting the challenge to select where the signature is valid. Transport and key custody are application concerns.

It also exports the [policy encoder, decoder, supported purchase selector, and owner-approval typed data](POLICY.md) used by the [owner portal](PORTAL.md). These helpers do not give the operating signer authority to update policy or sign as the owner.

## Service SDK

```ts
import { createServiceSdk } from "agentic-world/service";

const service = createServiceSdk({
  client: publicClient,
  chainId,
  audience: "https://service-a.example",
  implementation: agentAccountImplementation,
  registry: mandateRegistryAddress,
  challenges: durableChallengeStore,
  sessions: durableSessionStore,
});

const challenge = await service.issueChallenge(agentId);
const { token, session } = await service.authenticate(proof);
const active = await service.readSession(token);
// Apply this service's own ACL, subscription and agent-eligible-resource rules.
```

`ChallengeStore.consume(nonce)` **must be atomic** across all service replicas and return `false` if the nonce was already consumed. `SessionStore` receives only `SHA-256(token)` as a key, not the bearer token. Adapters should expire old records and protect the challenge/session database from unauthorized reads and writes. These are injected interfaces, not a shared Agentic World database.

For mandate-backed routes, `session.principal` is a short-lived cached result. If immediate mandate revocation matters, call `currentPrincipal(session.agentId)` and compare it to `session.principal` on that request. The service must still verify the principal's local account, current entitlement, and whether the route allows agents. Direct agent-specific grants work when `session.principal` is absent.

## Wire and freshness choices

- `audience` is an exact canonical HTTPS origin, for example `https://service-a.example`. Both SDKs reject paths, queries, fragments, custom default-port spellings, and non-HTTPS origins. The digest hashes its UTF-8 bytes with Keccak-256.
- `nonce` is 32 cryptographically random bytes. Challenge and session lifetimes default to 60 seconds; the service may configure 1–300 seconds. Timestamps are Unix seconds. The verifier accepts an `issuedAt` no more than 30 seconds in its future.
- The agent sends `{agentId,audience,chainId,nonce,issuedAt,expiresAt,signature}`. The service checks exact equality to its stored challenge, recomputes the digest, and ABI-encodes `AuthProof` for `0xAGENT.isValidSignature`. The service does not accept a caller-supplied digest or domain.
- The service checks `eth_getCode(0xAGENT) == 0xef0100 || pinnedImplementation` and reads `owner()` and ERC-1271 at the agent address. It compares the registry's `principalOf(agent)` to that owner before exposing a principal. Onchain reads for one authentication use one block number.
- A session is a local opaque token; by default it survives authenticator or mandate changes until expiry. `currentPrincipal` is a fresh mandate check. Immediate authenticator revocation of existing sessions is not implemented.

The contracts and SDKs do not implement service resource authorization, human account matching, arbitrary ERC-20 spending limits, or HTTP endpoint conventions. The onchain policy controls native-value calls and one narrow `purchaseCompute(address,uint256)` token action shape through `AgentAccount`.
