# Agentic World v0 implementation plan

The v0 account uses ERC-4337 for UserOperation validation and execution and a deliberately narrow ERC-7579 module surface: fixed `AgentValidator` and `AgentPolicyHook`. This is the active build plan, not the older EIP-7702 root-EOA design. See [protocol](PROTOCOL.md), [current implementation details](V0-IMPLEMENTATION.md), and [use cases](USECASE.md).

## Current state and next gates

| Layer | Implemented locally | Remaining completion gate |
| --- | --- | --- |
| Account and modules | `AgentAccount4337`, `AgentAccountFactory`, `AgentValidator`, `AgentPolicyHook`, `PolicyEngine`; deterministic initialized clone, owner-only lifecycle, fixed modules, ERC-1271, default-deny single-call policy | Test against a real configured EntryPoint/bundler, then deploy and verify trusted addresses on the chosen chain; security review |
| Core SDK | Shared account/factory ABIs, typed request/challenge/owner-approval data, clone-code check, policy encoding, execution calldata encoder | Version a deployment manifest and test against live deployed bytecode |
| Agent SDK | Injected digest signer, exact HTTP request and challenge proofs, `userOpHash` signing helper | Real KMS adapter and a complete UserOperation build/fund/submit/receipt path |
| Service SDK | `AgenticWorld` manual/owner association, pinned account-code and ERC-1271 checks, request nonce and challenge flows, local session interface | Durable atomic stores, HTTP middleware, service-specific permissions, reorg/freshness policy |
| Owner portal | Create/verify a clone, inspect modules and owner, rotate/revoke/restore signer, edit and preview onchain policy | Configure real trusted deployment addresses and test wallet flow on the target network |
| Service A and Service B | Not built | Two separate backends independently verify the same agent and enforce different local entitlements |
| Demo agent | Not built | Exercise both services plus the 2/20 token-policy case without human credentials |

The contract tests currently use `MockAgentEntryPoint`, a caller-boundary fixture. They do **not** establish full ERC-4337 interoperability, gas behavior, nonce handling, or bundler support. The repository has no public factory/EntryPoint deployment, live KMS adapter, production nonce/session stores, running HTTP services, or canonical MCP message format. Do not call the demo end-to-end until those gates are met.

## Contract and account gate

1. Choose the network and trusted EntryPoint deployment. Deploy `AgentAccountFactory(entryPoint)`; it deploys its own validator, policy hook, and account implementation. Record the factory, implementation, modules, EntryPoint, chain ID, and verified bytecode. No `MandateRegistry` or EIP-7702 delegation is part of this deployment.
2. From the intended human owner wallet, call `createAgent(authenticator, salt)`. The factory deploys a deterministic ERC-1167 clone and atomically initializes `owner = msg.sender`. The operating signer must be distinct from the owner and agent address. A service pins the implementation from a trusted deployment, not from an agent request.
3. Integrate a real bundler and submit a UserOperation signed by the operating key. Verify that only the configured EntryPoint can call `validateUserOp` and execute; the hook cannot be removed; self-calls, executor paths, batch/delegatecall/try modes, and owner-only configuration changes fail from the operating path.
4. Exercise default deny, autonomous allow, exact owner approval and replay rejection, key rotation/revocation, and supported token-purchase overcharge rejection. Obtain independent security review before treating the policy as a spending guarantee.

The owner is immutable after factory initialization. The implementation pointer is also immutable: a future EIP-8141/ERC-8286 account can be created with a new address, but this v0 identity cannot change its code in place. If preservation of the same address is a requirement, decide on an explicit upgrade architecture **before** public deployment.

## SDK and service gate

1. Keep the Core SDK as the single definition of EIP-712 proof types, ERC-1271 envelopes, factory/account ABIs, clone runtime check, and policy encoding. The old EIP-7702 helpers remain for historical compatibility only.
2. Implement a KMS adapter that signs the supplied digest exactly once and returns Ethereum-compatible 65-byte ECDSA signatures. Keep the human owner's signing authority outside the agent runtime. Add a UserOperation client that obtains the canonical hash, estimates/funds gas, submits to a bundler, and observes the receipt.
3. Give each service a trusted `pinnedImplementation`, expected chain and HTTPS audience, independent RPC client, and durable stores. The first-request flow uses an agent-generated random nonce; the service validates the actual method/target/body, checks ERC-1271, then atomically consumes `(agentId, nonce)`. The alternative challenge flow uses a service-generated, stored nonce. Neither nonce is consumed onchain.
4. Implement `manual` association through local agent enrollment or `owner` association through the verified clone's `owner()` at the authentication block. Resolve that address to a locally verified user. Then check the service's own paid entitlement, agent-eligible routes, rate limits, and resource policy. A valid agent proof or owner link alone is never sufficient.
5. Treat short sessions as service-local caches. Decide whether sensitive routes require a fresh proof or a new onchain check after key rotation/revocation. Define RPC confirmation/reorg handling, proxy request-target canonicalization, and storage TTLs before production use.

The [SDK guide](SDK.md) has the current agent/service integration surface. There is no shared Agentic World service database, global service ACL, or universal payment policy.

## Portal and demo gate

The [owner portal](PORTAL.md) is a static workbench. Its deployment map is intentionally empty until trusted factory and implementation addresses exist. A connected owner can create or verify an account, manage the operating key, and set a versioned onchain policy. The portal cannot grant service API access or enforce a model's offchain instructions.

Build Service A around a paid owner-linked read entitlement and Service B around a different agent-specific or manual enrollment rule. Each must independently verify the same `0xAGENT` and maintain separate nonce, session, user, and permission data. The demo agent should authenticate to both with its operating signer, show a route denied despite valid authentication, and demonstrate the 2-token autonomous versus 20-token owner-approved onchain action. The service still decides whether any payment unlocks a resource.

## Run local checks

```sh
npm install
npm run build
npm test
npm run typecheck
```

Passing local tests is a prototype milestone, not a public deployment, audit, or proof of real bundler interoperability. MCP request signing needs its own canonical wire format before it can be claimed as implemented.
