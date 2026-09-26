# Agentic World

Agentic World gives AI agents their own onchain identity to authenticate across services without impersonating humans, with owner-defined policies for onchain actions.

## Team

Built for ETHGlobal Tokyo 2026 by two developers:

- **[ryuux05 · GitHub](https://github.com/ryuux05)** — Blockchain engineer with over four years of experience across two startups.
- **[marcofernandioo · X](https://x.com/marcofernandioo)** — Frontend and robotics engineer.

## Try it: install → init → create → use a service

Use **Codex or Claude Code on your own computer**, with a wallet-enabled browser.
The skill teaches the agent the workflow; the local MCP holds the connection to
your hardware signer. You approve identity creation and policy changes yourself.

### Before you start

- Git, Node.js **22+**, npm, and a local Codex or Claude Code client.
- **macOS:** Secure Enclave-capable hardware and Apple's Swift command-line tools.
  **Windows:** native x64/ARM64 with a working TPM; the bundled signer needs no Go.
  Linux and cloud-only agent sessions are not supported by this hardware-signing flow.
- A MetaMask-compatible browser wallet on **Ethereum Sepolia (11155111)**, with
  Sepolia ETH for identity creation and policy transactions. Use testnet funds only.

You do **not** need Hardhat, `npm run demo`, an Upstash account, a bundler,
or USDC to try the hosted authentication and policy-preview demos below.

### Hosted demo versions

Checked on **27 September 2026**: both hosted services trust the original
implementation, `0xd08B955ca8727d86e708ae5684D5fa7f32635e66`.
The walkthrough uses **`main`**, which creates matching accounts through factory
`0x63f158897834bbc1579e82dfc29a7aacc8b91f93`.

This **`feat/policy-usdc-execution` branch** creates accounts through the newer
factory listed under [Deployed contracts](#deployed-contracts--sepolia).
Those new accounts need the services redeployed with the matching implementation
before hosted authentication will succeed. Existing identities are not upgraded.
Do not change trust checks or create repeated identities to work around a mismatch.

### 1. Install the skill

**Codex — from another project:** send this message in a Codex session:

```text
$skill-installer Install the skill from https://github.com/ryuux05/eth-tokyo-2026/tree/main/.agents/skills/agentic-world
```

Start a new session if the skill is not visible, then continue to step 2.

**Claude Code — or Codex using a checkout:** run these terminal commands:

```sh
git clone --branch main https://github.com/ryuux05/eth-tokyo-2026.git
cd eth-tokyo-2026
```

Open that folder in your local client (`claude` or `codex`).
The checkout already includes the project skill:
[Codex reads `.agents/skills`](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills);
[Claude Code reads `.claude/skills`](https://code.claude.com/docs/en/skills#choose-where-skills-load).
**Choose one installation route**, rather than adding a personal copy alongside
the project's copy. Reuse an existing installation; don't overwrite a conflicting
skill or MCP registration.

Installing the skill alone does not install the MCP. Init handles that next.
The one-command npm installer is prepared but **not yet published**; do not run
a similarly named third-party package. See [installer options](#installer-options).

### 2. Initialize the local MCP

Send this as a **chat message**, not a terminal command:

```text
agentic-world:init
```

For a source checkout, tell the agent to reuse that checkout. Init installs
dependencies, builds the MCP/portal/native signer, checks the host, creates a
private Sepolia configuration, and registers the MCP for your client.
It creates **no signing key, agent identity, or transaction**.

Choose the default public Sepolia RPC, or provide your own with
`agentic-world:init --rpc <https-url>`. Keep credential-bearing URLs in a local
environment variable (`AGENTIC_WORLD_RPC_URL`), not a shared prompt or commit.
Existing configuration is preserved unless you explicitly request a change.

**Restart Codex or Claude Code after registration.** Ask it to check
`agentic_identity`; it should report Sepolia and the expected deployment.
A new installation may correctly have no agent ID yet.

If Secure Enclave/TPM appears unavailable only inside the agent sandbox, have the
agent request approval for a host-level availability check. Do not export a key,
disable security controls, or substitute a software key. See
[signer troubleshooting](docs/LOCAL-SIGNER.md).

### 3. Create your agent identity

Send:

```text
agentic-world:create -a "Research"
```

1. The MCP provisions or reuses a hardware-backed P-256 authenticator and opens
   a temporary page in your default browser.
2. Connect the **owner wallet** you will also use on Services B and C.
3. Check Sepolia and the factory address, then approve the creation transaction.
4. Wait for confirmation and for the MCP to return the new **`0xAGENT`** address.

The agent address is separate from your owner wallet. The private authenticator
key stays in Secure Enclave/TPM; salt and public-key coordinates are filled in
automatically. You should not copy/paste keys or deployment salt.

Confirm it with `agentic-world:list`. Use `agentic-world:portal` to view identities,
edit aliases, and manage onchain policy. If a creation transaction was already
submitted but the page closed, check its hash before retrying—do not deploy twice.

### 4. Test Service B: read and write permissions

Open **[Service B](https://eth-tokyo-2026-demo-service-b.vercel.app/)** in your
wallet-enabled browser. Connect and sign in with the **same owner wallet** used
to create the agent; registration is a wallet message signature.

Ask Codex or Claude:

> Go to https://eth-tokyo-2026-demo-service-b.vercel.app/ and get my report.

The agent finds the report endpoint, responds to its Agentic World authentication
offer, and reads your private text. Its identity appears on the page after
authentication; Read starts enabled and Write starts disabled.
Your report belongs to **your wallet**, not everyone visiting the demo.
The page masks its text with stars by default.

Try these changes without creating another identity:

| Action in Service B | Ask your agent | Expected result |
| --- | --- | --- |
| Leave Read on | “Get my report again.” | Returns your text. |
| Turn Read off | “Get my report again.” | Access denied; no private text returned. |
| Leave Write off | “Update my report to Hello from my agent.” | Write denied. |
| Turn Write on | Repeat the update request. | Your report text changes. |
| Turn Read back on | “Get my report again.” | Returns the updated text. |

Check that denied requests are actually retried against the service, not answered
from the conversation's earlier copy of the report. Permissions take effect on
the **next request**, even with an existing session. Service B sessions expire
after **300 seconds**; the agent obtains a fresh proof when required.

Authentication stays on the resource endpoint: an ordinary 401 is not enough;
only a 401 explicitly offering `AgenticWorld` triggers this flow. The SDK handles
challenge/proof/session exchange on that endpoint—there is no separate
`/agent/challenge` endpoint to visit. The agent sends HTTP requests; the local MCP
only signs the service's challenge.

### 5. Test Service C: your agent's onchain policy

Open **[Service C](https://eth-tokyo-2026-demo-service-78xzh6jkd-ryuux05s-projects.vercel.app/)**.
This is the compute-credit storefront, **not Service A**.

1. Connect and register the same owner wallet.
2. Under **Service contract setup**, reuse an existing Service C purchase target
   or deploy one through your wallet. This one-time target deployment costs
   Sepolia gas; it does not redeploy your agent.
3. Enter your agent ID to inspect its policy. This is read-only inspection,
   not manual enrollment.
4. Use **Copy portal setup instructions**, paste them into your agent chat, and
   open `agentic-world:portal`. Review existing rules before changing anything:
   saving replaces the account's entire execution policy.
5. Add these **Token purchase** rules in order, then save onchain and approve
   the transaction with the owner wallet:

| Order | Target contract | Token / decimals | Maximum token amount | Decision |
| --- | --- | --- | --- | --- |
| 1 | The Service C purchase target | Sepolia USDC / 6 | `1` | `ALLOW` |
| 2 | The same purchase target | Sepolia USDC / 6 | `2` | `REQUIRE_OWNER_SIGNATURE` |

Token address: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`.
The native ETH value is zero. These rules match
`purchaseCompute(address token,uint256 amount)`, not a direct token transfer.
First match wins; unmatched actions default to **DENY**.
Amounts are human-readable USDC units in the portal; limits are per call,
not a cumulative budget or a USD price oracle.

After the policy transaction confirms, return to Service C and read the policy
again. Select the **1 USDC** pack and use **Copy prompt for agent**. Paste it into
Codex/Claude; it contains your target and the correct service URL. The agent
authenticates, gets the quote, and independently reads the account's policy.

Repeat with **2 USDC**:

| Proposed purchase | Expected onchain policy result |
| --- | --- |
| 1 USDC | `ALLOW` |
| 2 USDC | `REQUIRE_OWNER_SIGNATURE` |
| More than 2 USDC, with no other matching rule | `DENY` |

To demonstrate updates, change a limit in the portal, confirm the transaction,
then repeat the same check. Compare the policy revision and block returned by
the service and the independent check.

**Success means “purchase checked, not paid.”** No tokens move, no credits are
delivered, and this preview does not request a spending signature—even when the
decision is `REQUIRE_OWNER_SIGNATURE`. Service B demonstrates **service-owned
permissions**; Service C demonstrates **account-owned onchain policy**.

### Real payments are a separate test

This feature branch also implements direct USDC transfers through
`agentic_pay_usdc`; the Service C quote is not that execution path.
Payments require a new execution-capable account, a private Pimlico bundler
configuration, agent ETH/USDC funding, and transfer-specific policy.
To add or replace the bundler after init, say `agentic-world:configure-bundler`.
The skill guides you to stop the MCP, run `npm run configure:bundler` from this
checkout, paste the URL into a hidden terminal prompt, and restart the MCP.
After npm publication, the terminal command is `npx agenticworld configure-bundler`.
You can also supply `AGENTIC_WORLD_BUNDLER_RPC_URL` locally. Setup validates the
endpoint and preserves your identities; it does not send a payment. With no
bundler configured, authentication and policy previews still work.
Above-limit actions can request an exact-action owner signature.
A successful live hardware/Pimlico payment has **not yet been verified**.
Follow the [execution guide](docs/EXECUTION.md) rather than treating an
`ALLOW` preview as a receipt.

## Overview

Agentic World v0 uses an ERC-4337 / ERC-7579 smart account, an `AgentValidator`
for operating-key authentication and ERC-1271, and an `AgentPolicyHook` plus
`PolicyEngine` for owner-controlled onchain execution. Services independently
verify authentication and keep their own authorization rules, using manual or
`owner()`-derived association. The local MCP signs challenges; it never proxies
resource requests. P-256 verification uses EIP-7951's native `0x100` precompile.
EIP-8141 + ERC-8286 remain future work.

See the [architecture](docs/ARCHITECTURE-v0.md),
[implementation status](docs/V0-IMPLEMENTATION.md), [protocol](docs/PROTOCOL.md),
[service SDK](docs/SDK.md), [Core SDK](docs/CORE-SDK.md), [policy](docs/POLICY.md),
[owner portal](docs/PORTAL.md), and [MCP and skills](docs/MCP.md).
For developers running the manual-enrollment demo locally, see the
[Service A guide](docs/SERVICE-DEMO.md). Hosted demo details:
[Service B](demo-service-b/README.md) and [Service C](demo-service-c/README.md).

## Idea

Give an agent a persistent Ethereum smart account that it can use to authenticate
across services without borrowing a human's login session or access tokens. The
human retains control of the identity and its operating signers.

Agentic World is an authentication layer, not a mandate manager or a universal
permission system. It verifies which agent signed a request. Each service can
associate that agent with one of its users through explicit local enrollment
(`manual`) or by resolving `owner()` on a trusted agent account (`owner`). It
cannot verify the intent of a black-box model or enforce how the agent behaves
offchain. Each service decides whether and how that agent may access its resources.

## v0 scope

- An ERC-4337 / ERC-7579 modular agent account with owner binding,
  `AgentValidator`, and owner-controlled `AgentPolicyHook`.
- Service-issued, expiring challenges with single-use random nonces; the agent
  gets a short-lived, service-local session after ERC-1271 verification.
- A separate agent signing SDK and service verification SDK.
- Two independent services recognizing the same agent with different local permissions.
- A demonstration where a service chooses manual enrollment or owner-based
  association, then separately decides whether a paid account permits agent access.

Services verify proofs and relevant onchain identity state without depending on
an Agentic World-hosted authentication backend. They retain responsibility for
their own authorization, access policies, replay prevention, rate limits, and billing.

A global permission registry, onchain service ACLs, and universal payment policies
are not part of the core identity protocol.

## Status

The repository now contains `AgentAccount4337`, `AgentAccountFactory`,
`AgentValidator`, `AgentPolicyHook`, the Core/agent/service SDKs, local contract
tests, and a redesigned owner portal. The factory deploys an initialized
ERC-1167 clone and binds its owner to the human transaction sender. The service
SDK accepts that clone only when its runtime bytecode points to a trusted,
pinned implementation; the service-facing `AgenticWorld` manual/owner API is
unchanged. The old `AgentAccount` and `MandateRegistry` remain as historical
prototype code, not v0 deployment components.

The factory, implementation, validator, hook, and EntryPoint are pinned to
Sepolia in `sdk/deployments.ts`. `npm run demo` runs three loopback HTTP services
against that deployment. The local MCP supports macOS Secure Enclave and Windows
TPM signers, multiple identities, aliases, an owner portal, and browser-approved
creation, policy updates, rotation, and revocation.

**Execution deployment verified:** the current Sepolia factory includes the
management-target guard, ERC-165 discovery, transfer policies and expiring
P-256 execution signatures. Existing immutable accounts cannot be upgraded;
legacy identities remain authentication-only in the MCP. Real payments require
a new funded agent and a hands-on Pimlico/hardware test.

Local tests exercise P-256 authentication, both services, owner approval flows,
rotation across MCP restarts, and policy changes through the official EntryPoint
v0.8. Hardware signing and real wallet-extension interactions still need a
hands-on run. This feature branch adds direct USDC payments through a Pimlico
adapter, structured native signing, and exact-action owner approval. Local
end-to-end tests use a bundler fixture; live Pimlico submission is not yet verified.
The MCP retains the legacy identity pins; payments fail closed for those accounts.
Only single-call, revert-on-error ERC-7579 execution is supported, and execution
defaults to deny. See the [execution rollout and tools](docs/EXECUTION.md) and the
[implementation status and security limits](docs/V0-IMPLEMENTATION.md).

### Deployed contracts — Sepolia

Network: **Ethereum Sepolia**, chain ID **11155111**. These are the current
trusted addresses in [`sdk/deployments.ts`](sdk/deployments.ts).

| Component | Address |
| --- | --- |
| AgentAccountFactory | [0xf78336a75b7b517fdb784b1a34eae9527628b065](https://sepolia.etherscan.io/address/0xf78336a75b7b517fdb784b1a34eae9527628b065) |
| AgentAccount4337 implementation | [0x43671979CAA5d8631Fdddbc01c59Ea005516F5Bd](https://sepolia.etherscan.io/address/0x43671979CAA5d8631Fdddbc01c59Ea005516F5Bd) |
| AgentValidator | [0x6A9c4FA6B8a42B1c82B6d701cC76232633D243a0](https://sepolia.etherscan.io/address/0x6A9c4FA6B8a42B1c82B6d701cC76232633D243a0) |
| AgentPolicyHook | [0x72db3464519404302a95D65130b0a2fbE53E23d6](https://sepolia.etherscan.io/address/0x72db3464519404302a95D65130b0a2fbE53E23d6) |
| EntryPoint v0.8 (existing infrastructure) | [0x4337084d9e255ff0702461cf8895ce9e3b5ff108](https://sepolia.etherscan.io/address/0x4337084d9e255ff0702461cf8895ce9e3b5ff108) |

Factory deployment transaction:
[0x6041588b9ef0b0d83de192b19d6b11ff5a0e35231679439f43fa4fdfc6e42fa8](https://sepolia.etherscan.io/tx/0x6041588b9ef0b0d83de192b19d6b11ff5a0e35231679439f43fa4fdfc6e42fa8), block **11788771**.
The factory deployed the implementation, validator, and policy hook; each agent
gets its own account address when its owner creates it.

The [deployment record](deployments/sepolia-execution-v1.json) records the compiled
initcode and runtime code hashes. Legacy addresses remain in
`LEGACY_SEPOLIA_DEPLOYMENT`; their immutable accounts were not upgraded.

## Developer setup

To run the checks:

```sh
npm install
npm run build
npm test
npm run typecheck
```

For the interactive local workbench, run **one command** and leave it open:

```sh
npm run demo
```

It builds and serves Service A at `http://127.0.0.1:8787`, Service B at
`http://127.0.0.1:8797`, and Service C at `http://127.0.0.1:8807`, verifies the pinned Sepolia deployment, and prints the
Service A operator key. Their report endpoints are `/private/report`; Service A
also offers `/private/compute`. Set `AGENTIC_SERVICE_A_PORT` or
`AGENTIC_SERVICE_B_PORT` or `AGENTIC_SERVICE_C_PORT` to explicitly change ports. The command uses Sepolia;
it does not start Hardhat, deploy contracts, or build the local signer.

Service A requires each end user to enroll their agent with an owner-wallet
signature; the operator then grants resource permissions. Service B requires
wallet registration and associates an authenticated agent through its onchain
`owner()`. Service-local state resets on restart; onchain identities persist.
The legacy local-chain launcher is available explicitly as `npm run demo:hardhat`.

Service B also supports [Vercel deployment](demo-service-b/README.md). Register your
owner wallet, then tell your agent **“Go to https://eth-tokyo-2026-demo-service-b.vercel.app/ and get my
report.”** The homepage exposes the report link; the installed Agentic World skill
handles the SDK authentication offer. No copied protocol prompt or agent ID input
is needed. Hosted registrations and sessions use shared Redis rather than memory.

Service C is a **Next.js compute-credit storefront with read-only purchase checks**.
Register your owner wallet, select a 1 or 2 USDC pack, and copy the agent prompt.
Deploy or reuse its purchase contract once. Configure Token purchase rules in the
existing **Agentic World portal**, not in Service C. Enter an agent address to read
its policy, then update the policy in the portal and check again after confirmation.
The token is Sepolia USDC, `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`,
with six decimals. The threshold is per operation, not a cumulative budget or live USD price.
No USDC approval or payment is submitted from this page; do not fund the agent for this preview.

An agent can authenticate directly at `GET /private/quote?target=0xTARGET&amount=1`
on Service C using the same 401 challenge / proof-header / Agent-Session flow as A/B.
The response reports `evaluateAction()` and its block; HTTP 200 means the quote was
returned, **not** that spending was authorized or executed. A verified agent may
read its own quote when its owner is registered. Quotes include the proposed call
for an independent MCP policy check and explicitly report NOT_PAID; no credits are delivered.
`npm run dev:demo-service-c` runs only this storefront in development;
for production, build with `npm run build:demo-service-c` then run `npm run serve:demo-service-c`.
See [Service C deployment instructions](demo-service-c/README.md) for Vercel, browser wallet
support, and required shared Redis storage. The hosted audience uses the deployed origin.
`npm run test:service-c` separately proves real ERC-4337 execution locally: P-256
UserOperations, exact threshold, missing/wrong/replayed owner approvals, policy updates,
and token balance changes. These tests use local source deployments and test keys,
not the hosted services or your Secure Enclave/TPM key.

### Installer options

The [installer package](packages/agenticworld/README.md) is prepared but not
published to npm. **After official publication**, the command will be:

```sh
npx agenticworld install --client codex
```

Use `--client claude` or `--client both` for other clients.
`npx install agenticworld` is not the command; it runs a different package.

Developers can exercise the packaged installer from their chosen checkout:

```sh
npm ci
npm run build:installer
node packages/agenticworld/bin/agenticworld.js install --client codex
```

This installs the skill and MCP together; don't also do manual registration.
It preserves identity records and reports conflicts rather than overwriting
existing installations. Keep the selected runtime version compatible with the
service's pinned implementation. Restart the client after installation.

For manual build commands, MCP registration, Claude's local/user scope handling,
and RPC configuration, see the [MCP guide](docs/MCP.md).
For hardware requirements, see the [local signer guide](docs/LOCAL-SIGNER.md).

### Local-chain smoke test (developers only)

To deploy and exercise the complete local RPC + HTTP path, start a Hardhat node
in one terminal and run the smoke script in another:

```sh
npx hardhat node --hostname 127.0.0.1 --port 8545
# separate terminal
npm run demo:local
```

The script prints temporary deployment addresses and checks a policy-allowed
UserOperation, owner-based access at Service A (200), manual enrollment at
Service B (200), distinct sessions, cross-service proof rejection (401),
service-local admin denial (403), challenge replay rejection (401), and fresh-proof
rejection at both services after onchain key revocation (401/401). It uses
publicly known Hardhat owner keys, an ephemeral operating key passed only to
the demo agent process, and independent in-memory service stores. Its signed
audiences are canonical HTTPS origins, but loopback demo transport is HTTP;
do not copy that exception into a deployed service. It submits directly to
EntryPoint, not through a bundler. Restarting the Hardhat node clears deployments.
See [the local demo guide](docs/LOCAL-DEMO.md) for the complete flow.

The `agentic-world:portal` prompt opens the MCP-hosted loopback portal, including
your identity list and aliases. The standalone `npm run serve:portal` page can
also edit onchain policy but has no local MCP identity-list API. Both use the
Sepolia pins in [`portal/config.ts`](portal/config.ts).

To run only Service A, build it with `npm run build:demo-service` and run
`npm run serve:demo-service`; it also uses Sepolia. Grant and revoke report/compute
access, then retry with the same agent session; see the [hands-on guide](docs/SERVICE-DEMO.md).

The contract ABI and typed-data details are documented in the [protocol](docs/PROTOCOL.md).

## Security

Do not commit private keys, seed phrases, access tokens, or populated environment files.
Use placeholder values in any `.env.example` files.
