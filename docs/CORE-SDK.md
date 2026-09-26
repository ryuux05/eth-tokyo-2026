# Core SDK

`agentic-world/core` is the deterministic protocol boundary shared by the agent SDK, service SDK, and owner portal. It contains formats and ABIs, not a signer, hosted verification backend, nonce store, session store, or service permission engine.

The current exports include:

- `agentAccountAbi`, `agentAccountFactoryAbi`, and `agentPolicyAbi` for the v0 account, factory, and policy views/writes.
- EIP-712 builders and digests for challenge authentication, request-bound authentication, and exact-action owner approval; distinct ERC-1271 proof envelopes.
- `isExpectedAgentClone(code, pinnedImplementation)`, which compares exact ERC-1167 runtime bytecode. `isExpectedAgentAccountCode` also recognizes the historical EIP-7702 pointer format for compatibility. A v0 service should pin the new account implementation, not the old one.
- `encodePolicy`, `decodePolicy`, supported token-purchase selector and decision values, and `encodeAgentExecution` for ERC-7579 single-call account calldata.

The [agent SDK](SDK.md) supplies an injected digest signer; the owner wallet separately signs deployment, key-management, and policy transactions. The service SDK supplies its own RPC client, atomic nonce store, sessions, and authorization. Core does not convert `owner()` into a service grant.

`npm run build:sdk` emits JavaScript and declarations under `dist/sdk`. This remains a private prototype package; deployment-address manifests and public package versioning are not yet implemented. Historical `agentInitializationTypedData`, `agentRegistrationTypedData`, `mandateRegistryAbi`, and `isExpectedDelegation` exports remain for the EIP-7702 prototype only; they are not needed for v0 account creation.
