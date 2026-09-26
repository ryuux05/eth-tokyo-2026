# Local Secure Enclave signer

Agentic World uses a local helper for service-challenge authentication: Apple Secure Enclave on macOS, or the Microsoft Platform Crypto Provider with a TPM on Windows. Both generate non-exportable P-256 keys. MCP receives public keys and signed challenge proofs. The key is not an Ethereum EOA key. `AgentValidator` verifies P-256 through ERC-1271 and retains secp256k1 prototype compatibility.

```text
Agent → Service: request challenge for 0xAGENT
Agent → agentic_session_proof({ challenge })
      → local MCP checks the challenge and current onchain key
      → local helper validates structured AgentAuthentication fields
      → Secure Enclave signs the digest
      → MCP checks the returned proof matches the challenge
Agent → Service: submit proof
      → service verifies ERC-1271, consumes challenge, applies its own admission rule
Service → Agent: Agent-Session
Agent → Service: resource request with Agent-Session
```

The helper has no arbitrary `sign(bytes)` or `signDigest(bytes32)` command. The active MCP path accepts only a complete `AgentAuthentication` challenge with agent ID, canonical HTTPS audience, chain ID, service-generated nonce, and short validity window. MCP and helper validate it, and the service accepts it only if it matches a stored unused challenge. The helper retains a legacy structured `AgentRequest` command for compatibility tests; the MCP does not expose that command. Any canonical HTTPS origin is eligible; the service decides whether the agent may establish a session and access a resource.

The active EIP-712 `AgentAuthentication` fields are `agentId`, `audienceHash`, `nonce`, `issuedAt`, and `expiresAt`, under the account's chain-bound domain. On EIP-7951 chains, `AgentValidator` verifies P-256 natively through `P256VERIFY` at `0x100`; it does not fall back to Solidity. Each service independently verifies ERC-1271, consumes its own challenge atomically, resolves association, and issues its own short session. The agent—not MCP—holds that session token.

## Provisioning and use

On a Mac with Secure Enclave support:

```sh
npm run build:signer
dist/signer/agentic-signer availability
dist/signer/agentic-signer provision my-agent
```

A sandbox can report `secureEnclaveAvailable: false` even when the host supports it; init does not require provisioning and must not stop on that result. Actual hardware access is required for provisioning/signing. `provision` creates a new key and saves an opaque reference in Keychain. Normally `agentic_create_identity()` provisions on explicit request and opens owner-wallet approval. For a manual flow, use only public `qx`/`qy` coordinates in the [portal](PORTAL.md). Existing labels are never overwritten. `npm run init:mcp` creates the private signer config and prints its path for `AGENTIC_WORLD_CONFIG`; no exported operating key is used on Sepolia.

On Windows, `npm run build:signer` installs and self-tests the bundled executable for x64 or ARM64 after verifying its checksum. End users need no Go compiler. `dist/signer/agentic-signer.exe availability` checks TPM support. Windows hardware operations still require testing on a physical Windows host.

MCP rotation with `scheme: "p256"` provisions a fresh label and retains it per agent before wallet approval. Authentication selects the retained key matching current onchain public coordinates, so the old key still works if the owner cancels and the new key works after confirmation or a restart. Other identities sharing the original key remain unaffected. Revoked identities and key labels remain in local data; restoring a key is a separate owner action in the portal.

`npm run build:signer` compiles the helper with a fresh temporary Swift module cache and runs a deterministic Keccak/EIP-712 vector test. The isolated cache avoids clashes between differently cased macOS paths such as `Documents` and `documents`. This build is separate from `npm run demo` and does not provision a key. A physical Secure Enclave + Keychain signing run still requires a supported Mac and an explicitly created agent key; the repository's automated Hardhat tests use software P-256 keys for contract compatibility.

The prior `AGENTIC_WORLD_OPERATING_KEY` secp256k1 adapter remains solely for the local demo. It exposes the key to the MCP process and does not meet this local-key boundary. A host agent with unrestricted shell or filesystem access to the user's account is outside the signer boundary; OS account isolation and tool permissions still matter. The helper does not authorize owner-only account changes or ERC-4337 execution through its challenge-signing command.
