# Agentic World v0 implementation plan

The v0 account uses ERC-4337 for UserOperation validation and execution and a deliberately narrow ERC-7579 module surface: fixed `AgentValidator` and `AgentPolicyHook`. This is the active build plan, not the older EIP-7702 root-EOA design. See [protocol](PROTOCOL.md), [current implementation details](V0-IMPLEMENTATION.md), and [use cases](USECASE.md).

## Current state and next gates

| Layer | Implemented locally | Remaining completion gate |
| --- | --- | --- |
| Account and modules | `AgentAccount4337`, `AgentAccountFactory`, `AgentValidator`, `AgentPolicyHook`, `PolicyEngine`; deterministic initialized clone, P-256 or secp256k1 validator, owner-only lifecycle, fixed modules, ERC-1271, default-deny single-call policy; local EntryPoint v0.8 operation test | Integrate a bundler, then deploy and verify trusted addresses on the chosen chain; security review |
| Core SDK | Shared account/factory ABIs, typed request/challenge/owner-approval data, clone-code check, policy encoding, execution calldata encoder | Version a deployment manifest and test against live deployed bytecode |
| Agent SDK | Injected digest signer, exact HTTP request and challenge proofs, `userOpHash` signing helper; local P-256 Secure Enclave HTTP signer | Test physical-key signing and add a complete UserOperation build/fund/submit/receipt path |
| Service SDK | `AgenticWorld` manual/owner association, pinned account-code and ERC-1271 checks, request nonce and challenge flows, local session interface | Durable atomic stores, HTTP middleware, service-specific permissions, reorg/freshness policy |
| Owner portal | Create/verify a clone, inspect modules and owner, rotate/revoke/restore signer, edit and preview onchain policy | Configure real trusted deployment addresses and test wallet flow on the target network |
| Service A and Service B | Separate local HTTP processes use the service SDK with owner/manual association, independent stores, and different route grants | Durable stores, real account/payment integration, deployment and operations |
| Demo agent | Local process signs exact requests to both services and checks audience isolation, replay, authorization, and revocation | Secure Enclave-backed end-to-end run, bundler client, and 2/20 token-policy user journey |

The tests use both `MockAgentEntryPoint`, a caller-boundary fixture, and the official EntryPoint v0.8 contract locally. The latter covers a funded, signed UserOperation, signature rejection, nonce/replay handling, and service SDK authentication. A separate local demo starts two SDK-backed HTTP services and an agent process. These do **not** establish bundler support, gas estimation, physical Secure Enclave signing, or public-network behavior. The repository has no public factory/EntryPoint deployment, production nonce/session stores, or deployed HTTP services. The local MCP URL request format is implemented; see [MCP.md](MCP.md).

## Contract and account gate

1. Choose the network and trusted EntryPoint deployment. Deploy `AgentAccountFactory(entryPoint)`; it deploys its own validator, policy hook, and account implementation. Record the factory, implementation, modules, EntryPoint, chain ID, and verified bytecode. No `MandateRegistry` or EIP-7702 delegation is part of this deployment.
2. From the intended human owner wallet, call `createAgentP256(qx, qy, salt)` for a Secure Enclave key or `createAgent(authenticator, salt)` for the legacy secp256k1 path. The factory deploys a deterministic ERC-1167 clone and atomically initializes `owner = msg.sender`. A service pins the implementation from a trusted deployment, not from an agent request.
3. Integrate a real bundler and submit a UserOperation signed by the operating key. Verify that only the configured EntryPoint can call `validateUserOp` and execute; the hook cannot be removed; self-calls, executor paths, batch/delegatecall/try modes, and owner-only configuration changes fail from the operating path.
4. Exercise default deny, autonomous allow, exact owner approval and replay rejection, key rotation/revocation, and supported token-purchase overcharge rejection. Obtain independent security review before treating the policy as a spending guarantee.

The owner is immutable after factory initialization. The implementation pointer is also immutable: a future EIP-8141/ERC-8286 account can be created with a new address, but this v0 identity cannot change its code in place. If preservation of the same address is a requirement, decide on an explicit upgrade architecture **before** public deployment.

## SDK and service gate

1. Keep the Core SDK as the single definition of EIP-712 proof types, ERC-1271 envelopes, factory/account ABIs, clone runtime check, and policy encoding. The old EIP-7702 helpers remain for historical compatibility only.
2. For HTTP requests, use the local Secure Enclave signer with structured `AgentRequest` input and 64-byte P-256 signatures; it never accepts arbitrary digests. The existing agent SDK's injected digest signer remains useful for tests and legacy 65-byte secp256k1 accounts. Keep the human owner's signing authority outside the runtime. Add a separate approved UserOperation signing/client path that obtains the canonical hash, estimates/funds gas, submits to a bundler, and observes the receipt.
3. Give each service a trusted `pinnedImplementation`, expected chain and HTTPS audience, independent RPC client, and durable stores. The first-request flow uses an agent-generated random nonce; the service validates the actual method/target/body, checks ERC-1271, then atomically consumes `(agentId, nonce)`. The alternative challenge flow uses a service-generated, stored nonce. Neither nonce is consumed onchain.
4. Implement `manual` association through local agent enrollment or `owner` association through the verified clone's `owner()` at the authentication block. Resolve that address to a locally verified user. Then check the service's own paid entitlement, agent-eligible routes, rate limits, and resource policy. A valid agent proof or owner link alone is never sufficient.
5. Treat short sessions as service-local caches. Decide whether sensitive routes require a fresh proof or a new onchain check after key rotation/revocation. Define RPC confirmation/reorg handling, proxy request-target canonicalization, and storage TTLs before production use.

The [SDK guide](SDK.md) has the current agent/service integration surface. There is no shared Agentic World service database, global service ACL, or universal payment policy.

## Portal and demo gate

The [owner portal](PORTAL.md) is a static workbench. Its deployment map is intentionally empty until trusted factory and implementation addresses exist. A connected owner can create or verify an account, manage the operating key, and set a versioned onchain policy. The portal cannot grant service API access or enforce a model's offchain instructions.

The [local demo](LOCAL-DEMO.md) now runs Service A with a simulated paid owner-linked read entitlement and Service B with manual agent enrollment. Each verifies the same `0xAGENT` with separate nonce, session, user, and permission data. The agent authenticates to both and shows a route denied despite valid authentication. A real purchase-to-entitlement flow and the 2-token autonomous versus 20-token owner-approved user journey are still missing. Each service must decide whether any payment unlocks a resource.

## Run local checks

```sh
npm install
npm run build
npm test
npm run typecheck
```

For a persistent local JSON-RPC node, run `npx hardhat node --hostname 127.0.0.1 --port 8545`
in one terminal, then `npm run demo:local` in another. The script deploys
the official EntryPoint v0.8 implementation, factory, agent, and a demo target;
funds the agent's EntryPoint deposit; executes a signed UserOperation; then
starts two service processes and an agent process. It tests independent
authentication, local permission denial, audience/session isolation, nonce
replay, and fresh-proof rejection after onchain key revocation. See [local demo](LOCAL-DEMO.md).

Passing local tests is a prototype milestone, not a public deployment, audit, proof of physical Secure Enclave signing, or proof of bundler interoperability.
