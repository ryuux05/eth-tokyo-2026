# Owner registration page

The [owner portal](../portal/index.html) joins three owner tasks in one place: verify an existing agent identity, configure its onchain execution policy, and register the principal–agent mandate. It is a local, browser-built prototype, not an Agentic World authentication backend.

## Run it

1. Deploy `AgentAccount` and `MandateRegistry` to a chain that supports EIP-7702. Pin their trusted addresses by chain ID in [`portal/config.ts`](../portal/config.ts). The map is intentionally empty because this repository has no public deployment yet.
2. Run `npm run build:portal`, then `npm run serve:portal`. Open `http://localhost:4173` in a browser with an injected wallet.
3. Connect the **human owner** wallet and enter an already delegated, initialized `0xAGENT` address. The page checks the EIP-7702 pointer against the pinned implementation and checks `0xAGENT.owner()` against the connected wallet.
4. Add ordered native-call or token-purchase rules. Save them with an owner transaction to `0xAGENT.setPolicy(bytes)`. The page shows the resulting hash and can preview the current onchain policy for a 2- or 20-token purchase using `evaluateAction(...)` via `eth_call`.
5. Copy the registration EIP-712 typed data. Sign it **outside this page** with the agent root key, then paste only the 65-byte signature. The page checks that it recovers `0xAGENT` before asking the owner wallet to send `MandateRegistry.register(...)`.

The portal never asks for or stores a root private key, human seed phrase, or service credential. It does not create or bootstrap the agent EOA; that is a separate, high-trust workflow. It does not register a mandate until the owner transaction is confirmed. It does not claim a policy grants service access.

## Supported rule editor

The editor offers only protocol-supported v1 rule types. A native rule specifies exact target, selector, maximum ETH value, and `ALLOW` / `REQUIRE_OWNER_SIGNATURE` / `DENY`. A token-purchase rule specifies exact target, token, maximum token amount, token decimals, and decision; its selector is fixed to `purchaseCompute(address,uint256)`. The first match wins and the default is deny. Reordering buttons make this precedence visible.

Token amounts are encoded in base units using the selected decimals. The demo token has six decimals. Verify a real token's address, decimals, and target contract before saving a policy. The policy only checks the call's declared token and amount; it assumes the pinned target implements the purchase semantics the owner expects.

The page previews **saved onchain policy**, not unsaved draft rules. An `eth_call` has no transaction gas fee, though the RPC provider may charge for infrastructure use. The actual `execute` transaction always reevaluates the current policy.

## Deliberate limits

- No public addresses are silently assumed. Until `portal/config.ts` is set, verification and transactions remain unavailable on that chain.
- No agent-root private key import or browser key generation. Offline root signing is safer for this prototype.
- No owner wallet connection means no owner transaction. `setPolicy` and `register` are separate transactions; a saved policy does not itself register a mandate.
- No automatic service permissions or subscriptions. The service SDK independently verifies identity and mandate, then the service applies its local rules.
- No production-grade deployment verification, accessibility audit, browser screenshot review, KMS integration, or mainnet security audit yet.
