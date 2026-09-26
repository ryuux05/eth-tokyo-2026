# Agentic World v0 implementation

This page describes the code in this repository as of the ERC-4337 / ERC-7579 migration. It is a prototype, not an audited deployment. The older EIP-7702 `AgentAccount` and optional `MandateRegistry` remain only for historical tests and documentation.

**Sepolia deployment update required:** the pinned deployment predates the final-review management-target guard and ERC-165 discovery. An owner rule allowing execution against the policy hook or validator could bypass the account's owner-only wrappers. Source now rejects these targets in execution and preview. The factory/implementation pins still point at the existing deployment; a new factory deployment and explicit pin update are required to apply this fix on Sepolia. Existing immutable clones cannot be upgraded in place.

## Account creation and trust anchor

`AgentAccountFactory(entryPoint)` deploys one `AgentValidator`, one `AgentPolicyHook`, and one `AgentAccount4337` implementation. A human calls `createAgentP256(qx, qy, salt)` for a local Secure Enclave key or `createAgent(authenticator, salt)` for the earlier secp256k1 demo path. The factory deploys a deterministic ERC-1167 clone and atomically initializes `owner = msg.sender`, the operating authenticator, and the two fixed modules. `predictAgent(owner, salt)` is available before deployment. There is no agent-root EOA or EIP-7702 delegation in this path.

The owner cannot be changed by the agent. Only the owner can rotate, revoke, or restore the operating key and set a policy. Source rejects execution targeting the account or its management modules, validator/hook installation or removal, executor execution, delegatecall, batch calls, and non-reverting execution modes. It exposes ERC-165 for the implemented account interfaces; discovery is not a substitute for checking pinned code. V0 is deliberately a narrow ERC-7579 account rather than a general-purpose modular wallet.

An independent service pins the expected implementation address in trusted configuration. Its SDK checks the exact ERC-1167 runtime bytecode at `0xAGENT`, then checks the service proof with `isValidSignature` at the same block; owner mode reads `owner()` at that block. A generic ERC-7579 interface claim or agent-supplied owner is never sufficient. The legacy EIP-7702 pointer path remains in the SDK for older deployments; a v0 service should pin the new implementation and provision the factory separately.

## Agent authentication and service authorization

The active MCP path signs a service-issued `AgentAuthentication` challenge: agent address, service audience, chain, service-generated nonce, and issue/expiry times. The MCP checks the challenge against the configured onchain agent and asks the local Secure Enclave helper to sign its EIP-712 digest. It returns the proof without contacting the service. `AgentValidator` checks the signature behind the account's ERC-1271 interface. Services independently check their stored challenge, consume it atomically, apply service-owned admission, and issue a short-lived local session. The service-facing `new AgenticWorld({ association: { mode: "manual" | "owner", ... } })` API is preserved; older request-bound proofs remain in the SDK for compatibility.

Authentication establishes **which agent signed**. Manual mode resolves that agent through the service's local enrollment record; owner mode reads the pinned account's immutable owner and resolves that wallet to a local user. Neither mode inherits all permissions. The service checks its own route, subscription, payment, resource, and agent-eligibility rules. The onchain execution policy does not grant access to a service, and Agentic World cannot enforce the agent model's offchain intent.

## ERC-4337 execution and policy

The agent SDK can sign an EntryPoint-provided `userOpHash`; `encodeAgentExecution` builds the account call data for ERC-7579 single-call execution, optionally with an exact-action owner approval. The account accepts `validateUserOp` only from its configured EntryPoint and delegates signature validation to the fixed `AgentValidator`. Its execution path invokes `AgentPolicyHook` before and after the call. `PolicyEngine` defaults to deny and evaluates ordered, owner-set target/selector/value rules. The token-purchase demo decodes only `purchaseCompute(address,uint256)` and checks actual token balance change after the call; its limits are per call, not cumulative.

The operating key cannot set policy. A rule may require a separate owner EIP-712 signature bound to the exact action, current policy hash/revision, nonce, deadline, agent, and chain. This is an onchain action approval, not a service mandate.

## Portal

The [owner portal](PORTAL.md) creates/verifies accounts, manages operating keys and edits onchain policy. `agentic-world:portal` opens its MCP-hosted version with the local identity list and alias editing. `portal/config.ts` imports the pinned Sepolia deployment. The MCP creation/rotation tools provision local Secure Enclave or Windows TPM keys and open compact owner-wallet pages. The standalone portal also supports manually supplied public coordinates; a key changed there must have a matching retained local signer label before MCP can use it. No page asks for a private key.

## What remains before a live demo

- Redeploy the corrected account stack on Sepolia and update the trusted pins. A factory and EntryPoint are already deployed; they are not the same thing as verifying the corrected source onchain.
- Test the browser-wallet and physical Secure Enclave/TPM flow on the target machines. Automated lifecycle tests use explicit software signer and wallet fixtures.
- For agent onchain execution through MCP, add a structured hardware UserOperation signing path and bundler integration. These are not exposed by the authentication-only MCP today. Local tests exercise signed P-256 operations through the official EntryPoint v0.8, but not a bundler.
- Before deploying the example services publicly, replace in-memory stores with durable atomic stores and add real customer/payment systems, administration, TLS and rate limiting.
- Add independent security review, especially around hook reentrancy, token behavior, owner-key custody, RPC consistency/reorgs, and service replay storage. Do not treat local tests as an audit.

The ERC-1167 implementation pointer is immutable. This makes exact runtime provenance straightforward to check, but a future EIP-8141 / ERC-8286 implementation **cannot upgrade this v0 account at the same address**. A later account generation can use those standards with a new address, or an explicit migration/upgrade design must be agreed before deployment if preserving the same agent address is required. Service sessions also remain locally valid until their TTL unless a service rechecks onchain state; immediate key-revocation invalidation of existing sessions is not implemented.
