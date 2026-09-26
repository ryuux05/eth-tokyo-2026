# Local Secure Enclave signer

Agentic World uses a local macOS helper for request authentication. Its P-256 private key is generated in Apple Secure Enclave and is non-exportable; the model-facing MCP process receives only a public key and request proofs. The key is not an Ethereum EOA key. `AgentValidator` verifies its P-256 signatures through ERC-1271 (and can still verify the earlier secp256k1 demo accounts).

```text
Agent → agentic_request({ url, method, body? })
      → local MCP derives HTTPS audience and exact path/query
      → local helper validates structured AgentRequest fields
      → helper generates nonce and 60-second validity, hashes body and EIP-712 data
      → Secure Enclave signs the digest
      → MCP checks the returned proof matches its intended request
      → MCP sends request and proof to service
      → service verifies ERC-1271 and applies its own authorization
```

The helper has no arbitrary `sign(bytes)` or `signDigest(bytes32)` command. It accepts only an `AgentRequest` with `agentId`, `chainId`, HTTPS `audience`, uppercase supported `method`, origin-form `target`, and exact body bytes. It rejects malformed targets, GET bodies, and bodies over 64 KiB. It generates the nonce and timestamps internally. Any canonical HTTPS origin is eligible; the service decides whether the agent may access the resource. This is **not** an owner-configured service allowlist and does not enforce a black-box model's mandate.

The EIP-712 wire fields remain `agentId`, `audienceHash`, `nonce`, `issuedAt`, `expiresAt`, `methodHash`, `targetHash`, and `bodyHash`. The agent's simple URL input is not a wire-format change. Each service independently verifies the ERC-1271 signature and handles replay prevention, association, permissions, and sessions. A session token is cached only inside the MCP process, per HTTPS audience.

## Provisioning and use

On a Mac with Secure Enclave support:

```sh
npm run build:signer
dist/signer/agentic-signer availability
dist/signer/agentic-signer provision my-agent
```

The availability command must report `secureEnclaveAvailable: true` before provisioning. `provision` creates one new local key and stores the opaque key reference in macOS Keychain. It prints `qx` and `qy`; register those coordinates with `AgentAccountFactory.createAgentP256(qx, qy, salt)` from the human owner's wallet. Do not provision again with the same label; the helper will fail rather than replace an existing key. The account's onchain `authenticatorP256()` must match this local key. Set `signer.kind`, the absolute `binaryPath`, and `label` in `.agentic-world.json` as shown in [`mcp/config.example.json`](../mcp/config.example.json). Set only `AGENTIC_WORLD_CONFIG` in the MCP host environment; do **not** set `AGENTIC_WORLD_OPERATING_KEY` for this mode.

`npm run build:signer` compiles the helper and runs a deterministic Keccak/EIP-712 vector test. It does not provision a key. A physical Secure Enclave + Keychain signing run still requires a supported Mac and an explicitly provisioned agent key; the repository's automated Hardhat tests use software P-256 keys for contract compatibility.

The prior `AGENTIC_WORLD_OPERATING_KEY` secp256k1 adapter remains solely for the local demo. It exposes the key to the MCP process and does not meet this local-key boundary. A host agent with unrestricted shell or filesystem access to the user's account is outside the signer boundary; OS account isolation and tool permissions still matter. The helper does not authorize owner-only account changes or ERC-4337 execution through its HTTP authentication command.
