# Agentic World v0 implementation plan

The v0 account uses ERC-4337 for UserOperation validation and execution and a deliberately narrow ERC-7579 module surface: fixed `AgentValidator` and `AgentPolicyHook`. This is the active build plan, not the older EIP-7702 root-EOA design. See [protocol](PROTOCOL.md), [current implementation details](V0-IMPLEMENTATION.md), and [use cases](USECASE.md).

## Current state and next gates

| Layer | Implemented locally | Remaining completion gate |
| --- | --- | --- |
| Account and modules | Deterministic initialized clones, P-256 validator, owner-only lifecycle, fixed modules, ERC-1271, default-deny policy; source adds management-target isolation and ERC-165 | Redeploy the corrected source on Sepolia and update pins; bundler integration and security review |
| Core SDK | Shared ABIs, proof types, clone-code check, policy and execution encoders, pinned Sepolia deployment | Publish/version the SDK and update the deployment manifest after redeployment |
| Agent SDK | Injected digest signer, challenge and legacy request proofs, `userOpHash` signing helper; local P-256 Secure Enclave challenge signer | Test physical-key signing and add a complete UserOperation build/fund/submit/receipt path |
| Service SDK | `AgenticWorld` manual/owner association, pinned account-code and ERC-1271 checks, `createChallenge`, atomic challenge consumption, admission callback, local session interface | Durable atomic stores, HTTP middleware, service-specific permissions, reorg/freshness policy |
| Owner portal | Sepolia pins, MCP-hosted identity list and aliases, create/verify account, signer management, onchain policy editor | Hands-on wallet-extension and hardware validation on the target machines |
| Service A and Service B | Separate local HTTP processes use the service SDK with owner/manual association, independent stores, and different route grants | Durable stores, real account/payment integration, deployment and operations |
| Demo agent | Local process obtains service challenges, signs proofs, and uses separate service sessions; checks audience isolation, replay, authorization, and revocation | Secure Enclave-backed end-to-end run, bundler client, and 2/20 token-policy user journey |

The tests use both `MockAgentEntryPoint`, a caller-boundary fixture, and the official EntryPoint v0.8 locally. The P-256 MCP lifecycle also exercises both SDK-backed HTTP services, browser approval endpoints, policy updates, rotation, restart and revocation. A Sepolia factory and EntryPoint are pinned, but the final-review management-target guard and ERC-165 source changes require redeployment; see [current status](V0-IMPLEMENTATION.md). Tests do **not** establish bundler interoperability or physical hardware/wallet-extension behavior. Production challenge/session stores and public HTTP service hosting remain outside the example services.

## Contract and account gate

1. Choose the network and trusted EntryPoint deployment. Deploy `AgentAccountFactory(entryPoint)`; it deploys its own validator, policy hook, and account implementation. Record the factory, implementation, modules, EntryPoint, chain ID, and verified bytecode. No `MandateRegistry` or EIP-7702 delegation is part of this deployment.
2. From the intended human owner wallet, call `createAgentP256(qx, qy, salt)` for a Secure Enclave key or `createAgent(authenticator, salt)` for the legacy secp256k1 path. The factory deploys a deterministic ERC-1167 clone and atomically initializes `owner = msg.sender`. A service pins the implementation from a trusted deployment, not from an agent request.
3. Integrate a real bundler and submit a UserOperation signed by the operating key. Verify that only the configured EntryPoint can call `validateUserOp` and execute; the hook cannot be removed; self-calls, executor paths, batch/delegatecall/try modes, and owner-only configuration changes fail from the operating path.
4. Exercise default deny, autonomous allow, exact owner approval and replay rejection, key rotation/revocation, and supported token-purchase overcharge rejection. Obtain independent security review before treating the policy as a spending guarantee.

The owner is immutable after factory initialization. The implementation pointer is also immutable: a future EIP-8141/ERC-8286 account can be created with a new address, but this v0 identity cannot change its code in place. If preservation of the same address is a requirement, decide on an explicit upgrade architecture **before** public deployment.

## SDK and service gate

1. Keep the Core SDK as the single definition of EIP-712 proof types, ERC-1271 envelopes, factory/account ABIs, clone runtime check, and policy encoding. The old EIP-7702 helpers remain for historical compatibility only.
2. For service sessions, use the local Secure Enclave signer with structured `AgentAuthentication` challenge input and 64-byte P-256 signatures; it never accepts arbitrary digests. The existing agent SDK's injected digest signer remains useful for tests and legacy 65-byte secp256k1 accounts. Keep the human owner's signing authority outside the runtime. Add a separate approved UserOperation signing/client path that obtains the canonical hash, estimates/funds gas, submits to a bundler, and observes the receipt.
3. Give each service a trusted `pinnedImplementation`, expected chain and HTTPS audience, independent RPC client, and durable stores. The service creates a random, stored challenge for `0xAGENT`, verifies the returned proof through ERC-1271, atomically consumes the challenge, checks local session admission, and issues its own short-lived session. No nonce is consumed onchain. Older request-bound proof helpers remain for compatibility only.
4. Implement `manual` association through local agent enrollment or `owner` association through the verified clone's `owner()` at the authentication block. Resolve that address to a locally verified user. Then check the service's own paid entitlement, agent-eligible routes, rate limits, and resource policy. A valid agent proof or owner link alone is never sufficient.
5. Treat short sessions as service-local caches. Decide whether sensitive routes require a fresh proof or a new onchain check after key rotation/revocation. Define RPC confirmation/reorg handling, proxy request-target canonicalization, and storage TTLs before production use.

The [SDK guide](SDK.md) has the current agent/service integration surface. There is no shared Agentic World service database, global service ACL, or universal payment policy.

## Portal and demo gate

The [owner portal](PORTAL.md) uses pinned Sepolia addresses and has an MCP-hosted identity list and alias editor. A connected owner can create or verify an account, manage the operating key, and set a versioned onchain policy. The portal cannot grant service API access or enforce a model's offchain instructions.

`npm run demo` runs Service A with owner-signed manual enrollment and operator-managed permissions, and Service B with registered-wallet owner association. Both verify Sepolia identities using separate nonce/session/user state. The older [local smoke script](LOCAL-DEMO.md) uses synthetic services with the inverse A/B roles. A real purchase-to-entitlement journey remains unimplemented; token thresholds are tested at the contract level. Each service decides whether a payment unlocks resources.

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
