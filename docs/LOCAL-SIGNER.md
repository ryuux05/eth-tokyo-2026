# Local Secure Enclave signer

Agentic World uses a local macOS helper for service-challenge authentication. Its P-256 private key is generated in Apple Secure Enclave and is non-exportable; the model-facing MCP process receives only a public key and signed challenge proofs. The key is not an Ethereum EOA key. `AgentValidator` verifies its P-256 signatures through ERC-1271 (and can still verify earlier secp256k1 demo accounts).

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

The availability command must report `secureEnclaveAvailable: true` before provisioning. `provision` creates one new local key and stores the opaque key reference in macOS Keychain. Manual provisioning is optional: an explicit no-argument `agentic_create_identity()` call creates the key if its configured label does not exist, then opens a temporary browser wallet approval page. The MCP never sends the owner transaction itself. For a manual flow, copy the public `qx` and `qy` into the [owner portal](PORTAL.md) or call `AgentAccountFactory.createAgentP256(qx, qy, salt)` from the human owner's wallet. Do not provision again with the same label; the helper will fail rather than replace an existing key. The account's onchain `authenticatorP256()` must match this local key. Set `signer.kind`, the absolute `binaryPath`, and `label` in `.agentic-world.json` as shown in [`mcp/config.example.json`](../mcp/config.example.json). Set only `AGENTIC_WORLD_CONFIG` in the MCP host environment; do **not** set `AGENTIC_WORLD_OPERATING_KEY` for this mode.

`npm run build:signer` compiles the helper with a fresh temporary Swift module cache and runs a deterministic Keccak/EIP-712 vector test. The isolated cache avoids clashes between differently cased macOS paths such as `Documents` and `documents`. This build is separate from `npm run demo` and does not provision a key. A physical Secure Enclave + Keychain signing run still requires a supported Mac and an explicitly created agent key; the repository's automated Hardhat tests use software P-256 keys for contract compatibility.

The prior `AGENTIC_WORLD_OPERATING_KEY` secp256k1 adapter remains solely for the local demo. It exposes the key to the MCP process and does not meet this local-key boundary. A host agent with unrestricted shell or filesystem access to the user's account is outside the signer boundary; OS account isolation and tool permissions still matter. The helper does not authorize owner-only account changes or ERC-4337 execution through its challenge-signing command.
