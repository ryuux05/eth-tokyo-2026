# Core SDK

`agentic-world/core` is the protocol layer between the contracts and the two role-specific SDKs. It contains **definitions and deterministic encoding**, not a hosted authentication service, wallet, session database, or resource permission engine.

The core exports:

- Contract ABIs used for account verification, mandate registration/revocation, and policy reads/writes.
- EIP-712 typed-data builders for `AgentInitialization`, `AgentRegistration`, `AgentAuthentication`, and exact `OwnerActionApproval`.
- The authentication digest and ERC-1271 `AuthProof` ABI envelope.
- An exact EIP-7702 delegation-pointer check (`0xef0100 || pinnedImplementation`).
- The canonical versioned policy encoder/decoder, supported token-purchase selector, and decision enum.

```ts
import {
  agentRegistrationTypedData,
  encodePolicy,
  isExpectedDelegation,
} from "agentic-world/core";
```

The **service SDK** depends on core definitions to verify a challenge against the agent account and mandate registry. The **agent SDK** depends on them to sign the same challenge format. The **owner portal** uses them to read existing policy, encode a new policy, and prepare an agent-root registration permit. None of these layers independently invents an EIP-712 type string or policy ABI.

Core does not sign messages. The agent SDK receives an injected operating-key digest signer; the owner wallet signs transactions and owner approvals; the agent root key signs bootstrap and registration permits outside the portal. Those authorities must stay separate.

The package remains private in this prototype. `npm run build:sdk` emits the `core`, `agent`, and `service` entry points under `dist/sdk`. The onchain ABIs and typed messages are covered by local EIP-7702 integration and core round-trip tests. Public package versioning and deployment-address manifests are not yet in scope.
