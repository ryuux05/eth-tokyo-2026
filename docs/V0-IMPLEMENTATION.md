# Agentic World v0 implementation

This page describes the code in this repository as of the ERC-4337 / ERC-7579 migration. It is a prototype, not an audited deployment. The older EIP-7702 `AgentAccount` and optional `MandateRegistry` remain only for historical tests and documentation.

## Account creation and trust anchor

`AgentAccountFactory(entryPoint)` deploys one `AgentValidator`, one `AgentPolicyHook`, and one `AgentAccount4337` implementation. A human calls `createAgentP256(qx, qy, salt)` for a local Secure Enclave key or `createAgent(authenticator, salt)` for the earlier secp256k1 demo path. The factory deploys a deterministic ERC-1167 clone and atomically initializes `owner = msg.sender`, the operating authenticator, and the two fixed modules. `predictAgent(owner, salt)` is available before deployment. There is no agent-root EOA or EIP-7702 delegation in this path.

The owner cannot be changed by the agent. Only the owner can rotate, revoke, or restore the operating key and set a policy. The account rejects validator/hook installation or removal, executor execution, delegatecall, batch calls, and non-reverting execution modes. This limits the policy-bypass surface; it also means v0 is deliberately a narrow ERC-7579 account rather than a general-purpose modular wallet.

An independent service pins the expected implementation address in trusted configuration. Its SDK checks the exact ERC-1167 runtime bytecode at `0xAGENT`, then checks the service proof with `isValidSignature` at the same block; owner mode reads `owner()` at that block. A generic ERC-7579 interface claim or agent-supplied owner is never sufficient. The legacy EIP-7702 pointer path remains in the SDK for older deployments; a v0 service should pin the new implementation and provision the factory separately.

## Agent authentication and service authorization

The active MCP path signs a service-issued `AgentAuthentication` challenge: agent address, service audience, chain, service-generated nonce, and issue/expiry times. The MCP checks the challenge against the configured onchain agent and asks the local Secure Enclave helper to sign its EIP-712 digest. It returns the proof without contacting the service. `AgentValidator` checks the signature behind the account's ERC-1271 interface. Services independently check their stored challenge, consume it atomically, apply service-owned admission, and issue a short-lived local session. The service-facing `new AgenticWorld({ association: { mode: "manual" | "owner", ... } })` API is preserved; older request-bound proofs remain in the SDK for compatibility.

Authentication establishes **which agent signed**. Manual mode resolves that agent through the service's local enrollment record; owner mode reads the pinned account's immutable owner and resolves that wallet to a local user. Neither mode inherits all permissions. The service checks its own route, subscription, payment, resource, and agent-eligibility rules. The onchain execution policy does not grant access to a service, and Agentic World cannot enforce the agent model's offchain intent.

## ERC-4337 execution and policy

The agent SDK can sign an EntryPoint-provided `userOpHash`; `encodeAgentExecution` builds the account call data for ERC-7579 single-call execution, optionally with an exact-action owner approval. The account accepts `validateUserOp` only from its configured EntryPoint and delegates signature validation to the fixed `AgentValidator`. Its execution path invokes `AgentPolicyHook` before and after the call. `PolicyEngine` defaults to deny and evaluates ordered, owner-set target/selector/value rules. The token-purchase demo decodes only `purchaseCompute(address,uint256)` and checks actual token balance change after the call; its limits are per call, not cumulative.

The operating key cannot set policy. A rule may require a separate owner EIP-712 signature bound to the exact action, current policy hash/revision, nonce, deadline, agent, and chain. This is an onchain action approval, not a service mandate.

## Portal

The [owner portal](PORTAL.md) is a three-step Protocol Workbench: create or verify an agent, manage its operating key, and author/test its onchain policy. Chain-specific trusted factory and implementation addresses must be configured in `portal/config.ts`; the map is intentionally empty until deployment. The portal sends owner wallet transactions directly and never asks for an agent-root secret or KMS private key.

## What remains before a live demo

- Deploy and pin an ERC-4337 EntryPoint and factory on the selected chain; integrate a bundler and test simulation, gas estimation, and execution on that network. Local tests cover the mock caller boundary plus a signed, funded UserOperation through the official EntryPoint v0.8 contract, including nonce advancement and replay rejection, but **not** bundler interoperability.
- Exercise the Secure Enclave helper with a provisioned key on supported hardware and replace in-memory service nonce/session stores with durable, atomic stores; integrate actual customer/payment systems and deploy the services.
- Complete the owner portal's P-256 provisioning/registration flow. The current portal still centers the earlier secp256k1 account path.
- Add independent security review, especially around hook reentrancy, token behavior, owner-key custody, RPC consistency/reorgs, and service replay storage. Do not treat local tests as an audit.

The ERC-1167 implementation pointer is immutable. This makes exact runtime provenance straightforward to check, but a future EIP-8141 / ERC-8286 implementation **cannot upgrade this v0 account at the same address**. A later account generation can use those standards with a new address, or an explicit migration/upgrade design must be agreed before deployment if preserving the same agent address is required. Service sessions also remain locally valid until their TTL unless a service rechecks onchain state; immediate key-revocation invalidation of existing sessions is not implemented.
