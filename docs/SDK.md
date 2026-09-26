# Agent and service SDKs

The dependency order is `contracts → core → agent/service`; there is no Agentic World backend on a service's authentication path. Build the private package with `npm run build:sdk`. See [implementation status](V0-IMPLEMENTATION.md) before using it against a network.

| Entry point | Role | v0 responsibility |
| --- | --- | --- |
| `agentic-world/core` | Shared | Account/factory ABIs, proof formats, policy encoding, exact ERC-1167 clone check, single-call execution encoder. |
| `agentic-world/agent` | Agent runtime | Sign the exact HTTP request or challenge with an injected digest signer for legacy/testing paths; sign an EntryPoint-provided UserOperation hash. The local MCP uses a separate structured P-256 signer. |
| `agentic-world/service` | Independent service | Pin an implementation, verify account provenance and ERC-1271, atomically consume nonces, issue local sessions, resolve a local user through manual or owner association. |

## Agent-side request

```ts
import { createAgentSdk, requestProofHeaders } from "agentic-world/agent";

const agent = createAgentSdk({
  agentId,
  chainId,
  signDigest: digest => operatingAccount.sign({ hash: digest }), // local development signer
});
const request = { method: "GET", target: "/private/report", body: new Uint8Array() };
const proof = await agent.signRequest(request, "https://service-a.example");
const headers = requestProofHeaders(proof);
```

`signDigest` must return a 65-byte secp256k1 signature or a 64-byte P-256 `r || s` signature over the given digest—not a `personal_sign`/EIP-191 signature. The local [Secure Enclave signer](LOCAL-SIGNER.md) deliberately does **not** implement this arbitrary-digest interface; it accepts only structured HTTP `AgentRequest` input through MCP. The injected signer remains useful for tests and legacy integrations. `agent.signUserOperationHash(userOpHash)` and `encodeAgentExecution(target, value, data, approval?)` provide lower-level execution helpers; they do not build, fund, estimate, submit, or receipt-track a complete UserOperation.

## Service-side authentication

```ts
import { AgenticWorld, requestProofFromHeaders } from "agentic-world/service";

const agentic = new AgenticWorld({
  client: rpcClient,
  chainId,
  audience: "https://service-a.example",
  pinnedImplementation: trustedFactoryImplementation,
  requestNonces: durableAtomicNonceStore,
  sessions: durableSessionStore,
  association: {
    mode: "owner", // or "manual", with resolveUser(agentId)
    resolveUser: owner => db.user.findByWallet(owner),
  },
});

const proof = requestProofFromHeaders(headers, actualRequest, "https://service-a.example");
const { token, session, user } = await agentic.authenticateRequest(proof, actualRequest);
// Your service still checks whether user and session.agentId may access this route.
```

The configured implementation is a trusted startup pin, never a field accepted from the agent. For v0 accounts, the SDK checks exact ERC-1167 clone bytecode, then calls `0xAGENT.isValidSignature(...)`; owner mode reads `0xAGENT.owner()` at the same block. `manual` mode resolves the agent in the service's own enrollment database. A legacy EIP-7702 pointer check remains for an old implementation, but it is **not** the v0 account format. The optional lower-level legacy registry integration is not part of either `AgenticWorld` association mode.

The service must reconstruct the signed method, target, and body hash from the actual request, validate the audience/chain/time window, consume each nonce atomically across workers, and store only a hash of its random session token. For a **fresh proof**, the SDK bypasses viem's cached block number and verifies account code, owner (if requested), and ERC-1271 at the same current RPC block. A short session is an optimization, not a transferable human credential. `readSession` re-runs local association but does not revalidate the chain; a service needing immediate signer-revocation effect for an **existing session** must recheck onchain state or invalidate its own sessions. Service permissions, entitlements, payment rules, and agent-eligible routes remain entirely service-local.

The older service-challenge method (`issueChallenge` → `answerChallenge` → `authenticate`) remains available. It also uses ERC-1271 and local nonce/session stores, but the first-request path avoids a separate connection endpoint.
