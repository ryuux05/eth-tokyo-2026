# Agent and service SDKs

The dependency order is `contracts → core → agent/service`; there is no Agentic World backend on a service's authentication path. Build the private package with `npm run build:sdk`. See [implementation status](V0-IMPLEMENTATION.md) before using it against a network.

| Entry point | Role | v0 responsibility |
| --- | --- | --- |
| `agentic-world/core` | Shared | Account/factory ABIs, proof formats, policy encoding, exact ERC-1167 clone check, single-call execution encoder. |
| `agentic-world/agent` | Agent runtime | Answer a service challenge with an injected digest signer for testing/legacy paths; sign an EntryPoint-provided UserOperation hash. The local MCP uses a separate structured P-256 signer. |
| `agentic-world/service` | Independent service | Create challenges, pin an implementation, verify ERC-1271, atomically consume challenges, apply a service-owned admission callback, issue local sessions, and resolve a user through manual or owner association. |

## Agent-side session proof

```ts
import { createAgentSdk } from "agentic-world/agent";

const agent = createAgentSdk({
  agentId,
  chainId,
  signDigest: digest => operatingAccount.sign({ hash: digest }), // local development signer
});
const challenge = await fetchChallengeFromService(agentId);
const proof = await agent.answerChallenge(challenge, "https://service-a.example");
const session = await submitProofToService(proof);
// Use session.token as Agent-Session on later requests.
```

`signDigest` must return a 65-byte secp256k1 signature or a 64-byte P-256 `r || s` signature over the given digest—not a `personal_sign`/EIP-191 signature. The local [Secure Enclave signer](LOCAL-SIGNER.md) deliberately does **not** implement this arbitrary-digest interface; MCP passes it only a structured `AgentAuthentication` challenge. The injected signer remains useful for tests and legacy integrations. `agent.signUserOperationHash(userOpHash)` and `encodeAgentExecution(target, value, data, approval?)` provide lower-level execution helpers; they do not build, fund, estimate, submit, or receipt-track a complete UserOperation.

## Service-side authentication

```ts
import { AgenticWorld } from "agentic-world/service";

const agentic = new AgenticWorld({
  client: rpcClient,
  chainId,
  audience: "https://service-a.example",
  pinnedImplementation: trustedFactoryImplementation,
  challenges: durableAtomicChallengeStore,
  sessions: durableSessionStore,
  association: {
    mode: "owner", // or "manual", with resolveUser(agentId)
    resolveUser: owner => db.user.findByWallet(owner),
  },
  authorizeSession: async (identity, user) => servicePolicy.mayOpenAgentSession(user, identity.agentId),
});

const challenge = await agentic.createChallenge(agentId); // return from a service challenge endpoint
const { token, session, user } = await agentic.authenticate(proof); // service session endpoint
// Return token as Agent-Session; check route permissions on every later request.
```

The configured implementation is a trusted startup pin, never a field accepted from the agent. For v0 accounts, the SDK checks exact ERC-1167 clone bytecode, then calls `0xAGENT.isValidSignature(...)`; owner mode reads `0xAGENT.owner()` at the same block. `manual` mode resolves the agent in the service's own enrollment database. A legacy EIP-7702 pointer check remains for an old implementation, but it is **not** the v0 account format. The optional lower-level legacy registry integration is not part of either `AgenticWorld` association mode.

The service must issue and store each random challenge before the agent signs it, validate its chain/audience/time window, atomically consume it across workers, and store only a hash of the resulting random session token. For a **fresh proof**, the SDK bypasses viem's cached block number and verifies account code, owner (if requested), and ERC-1271 at the same current RPC block. `AgenticWorld.authenticate` resolves the service user and runs `authorizeSession` before storing the session; a missing association is denied. `readSession` re-runs local association but does not revalidate the chain. A service needing immediate signer-revocation effect for an **existing session** must recheck onchain state or invalidate its own sessions. Route permissions, entitlements, payment rules, and agent-eligible resources remain entirely service-local and must be checked on each request.

The old name `issueChallenge` and request-bound first-request proof helpers remain for compatibility, but the active MCP/demo path is `createChallenge` → `agentic_session_proof` → `authenticate` → `Agent-Session`.
