# Owner portal — Protocol Workbench

The [owner portal](../portal/index.html) is a local setup tool for a human creating and configuring one v0 agent. Its visual and interaction choices are documented in [PRODUCT.md](../PRODUCT.md) and [DESIGN.md](../DESIGN.md). It is not an authentication backend or a service-permission manager. To change API permissions and observe them take effect, use the separate [Service A permission workbench](SERVICE-DEMO.md).

## Run

The portal is optional. `npm run demo` starts Service A and B against Sepolia.
Use `agentic-world:portal` to open the MCP-hosted portal with all locally managed
identities and aliases. The skill and MCP open a smaller, temporary
browser wallet page for identity creation; a human wallet still has to approve
its transaction. Use the full portal for manual owner management or policy editing.

1. Sepolia is pinned in [`portal/config.ts`](../portal/config.ts). Read the [deployment caveat](V0-IMPLEMENTATION.md): the final-review contract corrections require a new deployment before onchain execution can be considered ready.
2. Run `npm run build:portal` and `npm run serve:portal`, then open `http://localhost:4173` in a browser with an injected owner wallet.
3. Provision a local Secure Enclave key first (see [local signer](LOCAL-SIGNER.md)), then copy its public `qx` and `qy` coordinates into the P-256 creation fields. Connect the human owner wallet. The page checks that the configured factory reports the pinned implementation and calls `createAgentP256(qx, qy, salt)`. The earlier `createAgent(address, salt)` path remains available under “Legacy Ethereum signer.” A new agent is a deterministic ERC-1167 clone with `owner = msg.sender` from the owner wallet's factory transaction.
4. The page checks clone runtime code, account version and authenticator scheme, owner, and installed validator/hook at one block. It shows the active P-256 coordinates (or legacy signer address) and lets the owner rotate, revoke, or restore the key using the matching contract method. An existing agent can be loaded by address.
5. Create ordered onchain execution rules. The page displays the encoded policy hash, saves only after the owner confirms an account transaction, and can preview the saved 2/20 token-purchase decisions. Unsaved drafts are not executed or treated as service access rights.

The portal never asks for a seed phrase, agent-root key, KMS private key, or service credential. The operating signer cannot use the page to change the owner or policy. Revocation stops new operating-key signatures, but does not automatically invalidate a service session already issued by an independent service.

## Boundaries

- A missing or mismatched trusted deployment disables creation and verification. Switching wallet/network requires reconnecting; transactions check the current chain before submission.
- The editor supports native calls and the specifically decoded `purchaseCompute(address,uint256)` token-purchase action. Limits apply per call, not across time. First matching policy rule wins; the default is deny.
- The policy hook restricts onchain account execution. It cannot control a model's offchain behavior or grant the agent access to a service. Services independently choose manual or owner-derived association and their own authorization.
- The standalone portal is a static build; the MCP-hosted version adds local identity/alias APIs. The portal does not provision hardware keys or integrate a bundler. Prefer MCP creation/rotation so the local signer labels remain associated with the identity. Manual key changes require corresponding signer configuration; copy only public coordinates, never private keys. See [implementation status](V0-IMPLEMENTATION.md).
