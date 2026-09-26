# Owner portal — Protocol Workbench

The [owner portal](../portal/index.html) is a local setup tool for a human creating and configuring one v0 agent. Its visual and interaction choices are documented in [PRODUCT.md](../PRODUCT.md) and [DESIGN.md](../DESIGN.md). It is not an authentication backend or a service-permission manager. To change API permissions and observe them take effect, use the separate [Service A permission workbench](SERVICE-DEMO.md).

## Run

The portal is optional. `npm run demo` starts Service A and B against Sepolia.
Use `agentic-world:portal` to open the MCP-hosted portal with all locally managed
identities and aliases. The skill and MCP open a smaller, temporary
browser wallet page for identity creation; a human wallet still has to approve
its transaction. Use the full portal for manual owner management or policy editing.

1. Sepolia is pinned in [`portal/config.ts`](../portal/config.ts). Read the [deployment caveat](V0-IMPLEMENTATION.md): the final-review contract corrections require a new deployment before onchain execution can be considered ready.
2. Build with `npm run build:portal` and open `agentic-world:portal` through the connected local MCP. A standalone `npm run serve:portal` page can inspect existing accounts and manage policy, but cannot provision hardware keys; it directs creation/rotation/restore users to the MCP-hosted portal.
3. Enter an optional alias and choose **Create agent identity**. MCP provisions or reuses the local hardware P-256 key, obtains its public `qx`/`qy`, and generates a random deployment salt internally. The private key stays in macOS Secure Enclave or Windows TPM; no coordinates or salt are user inputs. The existing one-time creation page opens automatically. Connect the owner wallet and approve its factory transaction. MCP checks the trusted factory, verifies the receipt and account/key, then saves the identity and alias locally. The account's owner is the wallet that calls the factory, not a user-editable owner field.
4. Load an existing agent to inspect its owner and installed modules. Rotate/Restore automatically prepare a new hardware-backed key and open owner-wallet approval; retained key labels let MCP keep signing after confirmation or restart. Public coordinates remain available as read-only technical details. Revocation still requires the connected owner's wallet transaction. Closing an unsubmitted approval page releases the flow; check an already submitted transaction before retrying.
5. Create ordered onchain execution rules. The page displays the encoded policy hash, saves only after the owner confirms an account transaction, and can preview the saved 2/20 token-purchase decisions. Unsaved drafts are not executed or treated as service access rights.

The portal never asks for a seed phrase, agent-root key, KMS private key, or service credential. The operating signer cannot use the page to change the owner or policy. Revocation stops new operating-key signatures, but does not automatically invalidate a service session already issued by an independent service.

## Boundaries

- MCP verifies its trusted deployment before provisioning a creation flow. The approval page requires the matching wallet network. A missing or mismatched portal deployment disables existing-account verification; reconnect after switching wallet/network.
- The editor supports native calls and the specifically decoded `purchaseCompute(address,uint256)` token-purchase action. Limits apply per call, not across time. First matching policy rule wins; the default is deny.
- The policy hook restricts onchain account execution. It cannot control a model's offchain behavior or grant the agent access to a service. Services independently choose manual or owner-derived association and their own authorization.
- The standalone portal is a static build; the MCP-hosted version adds local identity/alias APIs and guarded creation/key-replacement actions. Browsers never access private key material. Local mutation APIs require the one-time portal URL and matching Origin; creation accepts only an optional alias, and key replacement only a managed agent ID plus action. Neither portal mode integrates a bundler. See [implementation status](V0-IMPLEMENTATION.md).
