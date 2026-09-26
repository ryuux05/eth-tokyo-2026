# Agentic World v0 architecture freeze

This is the v0 architecture now implemented in the contracts, SDKs, and owner portal, with important live-demo gaps. See [current implementation and limits](V0-IMPLEMENTATION.md). The older EIP-7702 code remains historical and is not the v0 deployment path.

## Boundaries

| Layer | v0 choice | Responsibility |
| --- | --- | --- |
| Account and execution | ERC-4337 smart account, ERC-7579 modular interface | `0xAGENT` is a deployed smart account. It executes `UserOperation`s through a trusted EntryPoint. |
| Identity | `0xAGENT`, `owner() = 0xHUMAN` | Persistent agent identity and human association. `owner()` is not a grant of the human's service permissions. |
| Agent authentication | `AgentValidator`, P-256 Secure Enclave or legacy secp256k1 operating key, ERC-1271 | Validate agent-signed UserOperations and service proofs without giving the runtime the human's key. P-256 requires EIP-7951 at `0x100`; unsupported chains fail closed. |
| User execution policy | `AgentPolicyHook` + `PolicyEngine` | Gate onchain execution by the agent account according to owner-configured rules. This cannot enforce the agent's offchain instructions. |
| Service authentication | Service challenge → MCP proof → ERC-1271 → short-lived service session | Each service issues and verifies its own challenge; MCP signs but does not send the HTTP request. |
| Service authorization | Service database | Each service chooses manual agent registration **or** `owner()`-derived association, then applies its own route, entitlement, payment, and resource rules. |

These are distinct decisions: authenticating `0xAGENT`, associating it with a service user, allowing a service resource, and authorizing an onchain account action. Neither `owner()` nor an onchain execution policy is a universal service mandate. Agentic World cannot verify a black-box model's intent.

## ERC-4337 execution path

1. The agent runtime asks its separate operating key to sign a `UserOperation` for `0xAGENT`. It does not hold the owner's key or an agent-root EOA key. The local Secure Enclave helper currently exposes HTTP request signing only; a UserOperation helper is a separate pending path.
2. In a live deployment, a bundler submits the operation to the configured ERC-4337 EntryPoint. The account's `validateUserOp` calls its fixed `AgentValidator`. Local tests now cover both a caller fixture and a complete operation through the official EntryPoint v0.8 contract; they do not use a bundler.
3. The EntryPoint calls the account's ERC-7579 single-call execution entrypoint. `AgentPolicyHook` checks the action before execution and checks token spend afterward. Batch, delegatecall, executor, and try modes are unsupported.
4. The human directly calls owner-only key and policy methods. The operating validator cannot install/remove modules, upgrade the account, or change `owner()`.

The hook is an execution boundary, **not** a replacement for signature validation. The account prevents module changes and executor execution so the operating validator cannot remove the hook or take those alternate paths. [ERC-4337](https://eips.ethereum.org/EIPS/eip-4337), [ERC-7579](https://eips.ethereum.org/EIPS/eip-7579)

## Service request path

1. The agent asks the service for a challenge for `0xAGENT`. The service SDK stores a random nonce, expected agent, audience, chain, and short expiry. The agent passes the challenge to `agentic_session_proof`; MCP checks the current onchain key and signs the structured `AgentAuthentication` object without contacting the service.
2. The agent submits the proof to the service. The service checks its stored challenge and calls `0xAGENT.isValidSignature(digest, encodedProof)` via `eth_call`. The smart account forwards the ERC-1271 check to the installed `AgentValidator`.
3. The service atomically consumes the challenge, maps the agent to a local user by explicit registration (`manual`) or verified `owner()` (`owner`), runs its own session-admission rule, and creates a short-lived, service-local `Agent-Session`.
4. The agent sends later resource requests with `Agent-Session`. The service checks route/resource permissions on every request. Sessions, challenges, and entitlements stay in that service's database; a valid signature is not itself a resource grant.

For owner association, services pin the trusted implementation, compare the agent's exact ERC-1167 clone runtime to that implementation, and read `owner()` at the same block as ERC-1271 verification. The account has no upgrade path and its owner cannot be changed after atomic factory initialization. An agent-supplied `owner` value is never sufficient. [ERC-7579 ERC-1271 forwarding](https://eips.ethereum.org/EIPS/eip-7579#erc-1271-forwarding)

## Migration and scope

- The account, factory, fixed modules, clone-provenance check, SDK execution encoder, owner portal, local MCP, and local EntryPoint v0.8 execution test are implemented. The P-256 signer compiles and passes an EIP-712 vector test, but physical Secure Enclave signing, public deployment, bundler integration, and live services remain outstanding.
- Recovery of the immutable owner belongs in the owner's wallet architecture. The EIP-7702 bootstrap and optional `MandateRegistry` are **not v0 components**.
- Keep EIP-8141 frame transactions and ERC-8286 modular frame accounts as a **future migration**, not a v0 dependency. ERC-8286 is currently a draft. In particular, direct `SENDER` frames can execute without passing through the ERC-7579 execution hook; execution policy must be enforced during frame validation before approving them. [EIP-8141](https://eips.ethereum.org/EIPS/eip-8141), [ERC-8286 security considerations](https://eips.ethereum.org/EIPS/eip-8286#security-considerations)

Open deployment details: chain and real EntryPoint/factory addresses, bundler integration, physical-key provisioning and signing, and session invalidation after onchain key changes. The immutable clone makes an in-place EIP-8141/ERC-8286 migration impossible for existing v0 addresses; preserving an agent address would require a different explicit design before public deployment.
