# Owner portal — Protocol Workbench

The [owner portal](../portal/index.html) is a local setup tool for a human creating and configuring one v0 agent. Its visual and interaction choices are documented in [PRODUCT.md](../PRODUCT.md) and [DESIGN.md](../DESIGN.md). It is not an authentication backend or a service-permission manager. To change API permissions and observe them take effect, use the separate [Service A permission workbench](SERVICE-DEMO.md).

## Run

For the interactive local workbench, use `npm run demo`: it starts the chain,
deploys the factory, and serves this portal with its fresh deployment without
editing `portal/config.ts`. The steps below are for standalone use.

1. Deploy a trusted `AgentAccountFactory` with the chosen EntryPoint address. Record the factory's `implementation()` and configure both addresses under the chain ID in [`portal/config.ts`](../portal/config.ts). The map is empty by default: there is no public deployment to assume.
2. Run `npm run build:portal` and `npm run serve:portal`, then open `http://localhost:4173` in a browser with an injected owner wallet.
3. Provision a local Secure Enclave key first (see [local signer](LOCAL-SIGNER.md)), then copy its public `qx` and `qy` coordinates into the P-256 creation fields. Connect the human owner wallet. The page checks that the configured factory reports the pinned implementation and calls `createAgentP256(qx, qy, salt)`. The earlier `createAgent(address, salt)` path remains available under “Legacy Ethereum signer.” A new agent is a deterministic ERC-1167 clone with `owner = msg.sender` from the owner wallet's factory transaction.
4. The page checks clone runtime code, account version and authenticator scheme, owner, and installed validator/hook at one block. It shows the active P-256 coordinates (or legacy signer address) and lets the owner rotate, revoke, or restore the key using the matching contract method. An existing agent can be loaded by address.
5. Create ordered onchain execution rules. The page displays the encoded policy hash, saves only after the owner confirms an account transaction, and can preview the saved 2/20 token-purchase decisions. Unsaved drafts are not executed or treated as service access rights.

The portal never asks for a seed phrase, agent-root key, KMS private key, or service credential. The operating signer cannot use the page to change the owner or policy. Revocation stops new operating-key signatures, but does not automatically invalidate a service session already issued by an independent service.

## Boundaries

- A missing or mismatched trusted deployment disables creation and verification. Switching wallet/network requires reconnecting; transactions check the current chain before submission.
- The editor supports native calls and the specifically decoded `purchaseCompute(address,uint256)` token-purchase action. Limits apply per call, not across time. First matching policy rule wins; the default is deny.
- The policy hook restricts onchain account execution. It cannot control a model's offchain behavior or grant the agent access to a service. Services independently choose manual or owner-derived association and their own authorization.
- The portal is currently a static browser build. It does not provision Secure Enclave keys itself and has no pinned public factory addresses, bundler, or recovery mechanism. Copy only public coordinates from the local signer; the private key must stay there. The chosen chain also needs the native P-256 verification precompile. See [implementation status](V0-IMPLEMENTATION.md).
