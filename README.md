# Agentic World

Agent-native, portable identity and authentication for independent services.

Built for ETHGlobal Tokyo 2026.

**Architecture freeze:** Agentic World v0 uses an ERC-4337 / ERC-7579 smart
account, an `AgentValidator` for operating-key authentication and ERC-1271, and an
`AgentPolicyHook` plus `PolicyEngine` for owner-controlled onchain execution.
The protocol lets services verify signed authentication challenges independently and keep their own
authorization rules, with manual or `owner()`-derived agent association. See the
[v0 architecture](docs/ARCHITECTURE-v0.md). The local MCP signs service-issued
challenges and returns the proof to the agent; it never proxies resource requests. P-256 verification uses EIP-7951's native `0x100` precompile;
EIP-8141 + ERC-8286 remain future work.

Start with the [current implementation](docs/V0-IMPLEMENTATION.md),
[architecture](docs/ARCHITECTURE-v0.md), [owner portal guide](docs/PORTAL.md),
and [design system](DESIGN.md). The [protocol](docs/PROTOCOL.md),
[policy](docs/POLICY.md), [Core SDK](docs/CORE-SDK.md), [service SDK](docs/SDK.md),
and [implementation plan](docs/IMPLEMENTATION.md) describe the current v0 path.
For Codex/Claude Code integration, see the [local MCP server and skills](docs/MCP.md).
To try live service-owned permissions in a browser, see the [Service A permission workbench](docs/SERVICE-DEMO.md).
Legacy EIP-7702 code and compatibility helpers are identified separately.

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
Sepolia in `sdk/deployments.ts`. `npm run demo` runs two loopback HTTP services
against that deployment. The local MCP supports macOS Secure Enclave and Windows
TPM signers, multiple identities, aliases, an owner portal, and browser-approved
creation, policy updates, rotation, and revocation.

**Deployment update required:** the final review found that a policy could allow
agent execution to call its own management modules directly. Source now blocks
those targets and includes ERC-165 discovery, but the pinned Sepolia deployment
predates these changes. Deploy a new factory and update the pins before treating
onchain execution as ready. Existing immutable accounts cannot be upgraded.

Local tests exercise P-256 authentication, both services, owner approval flows,
rotation across MCP restarts, and policy changes through the official EntryPoint
v0.8. Hardware signing and real wallet-extension interactions still need a
hands-on run. Services intentionally use in-memory stores; there is no bundler
integration or MCP UserOperation execution tool. Only single-call, revert-on-error
ERC-7579 execution is supported, and execution defaults to deny. See the
[implementation status and security limits](docs/V0-IMPLEMENTATION.md).

### Deployed contracts — Sepolia

Network: **Ethereum Sepolia**, chain ID **11155111**. These are the current
trusted addresses in [`sdk/deployments.ts`](sdk/deployments.ts).

| Component | Address |
| --- | --- |
| AgentAccountFactory | [0x63f158897834bbc1579e82dfc29a7aacc8b91f93](https://sepolia.etherscan.io/address/0x63f158897834bbc1579e82dfc29a7aacc8b91f93) |
| AgentAccount4337 implementation | [0xd08B955ca8727d86e708ae5684D5fa7f32635e66](https://sepolia.etherscan.io/address/0xd08B955ca8727d86e708ae5684D5fa7f32635e66) |
| AgentValidator | [0x8626C6788393632e7Cd07992B6E97E5B9c2eaF55](https://sepolia.etherscan.io/address/0x8626C6788393632e7Cd07992B6E97E5B9c2eaF55) |
| AgentPolicyHook | [0x64C2685aDD03EBcaDf4b769B39f7979A1b3a5968](https://sepolia.etherscan.io/address/0x64C2685aDD03EBcaDf4b769B39f7979A1b3a5968) |
| EntryPoint v0.8 (existing infrastructure) | [0x4337084d9e255ff0702461cf8895ce9e3b5ff108](https://sepolia.etherscan.io/address/0x4337084d9e255ff0702461cf8895ce9e3b5ff108) |

Factory deployment transaction:
[0xb9fe814993ba3cda718853d5648bda2dc38c5e687b2e8646a44bd7f92286c15c](https://sepolia.etherscan.io/tx/0xb9fe814993ba3cda718853d5648bda2dc38c5e687b2e8646a44bd7f92286c15c).
The factory deployed the implementation, validator, and policy hook; each agent
gets its own account address when its owner creates it.

**These addresses predate the management-target guard and ERC-165 fixes described
above.** Listing them does not mean the corrected source has been redeployed.

### Run locally

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

It builds and serves Service A at `http://127.0.0.1:8787` and Service B at
`http://127.0.0.1:8797`, verifies the pinned Sepolia deployment, and prints the
Service A operator key. Their report endpoints are `/private/report`; Service A
also offers `/private/compute`. Set `AGENTIC_SERVICE_A_PORT` or
`AGENTIC_SERVICE_B_PORT` to explicitly change ports. The command uses Sepolia;
it does not start Hardhat, deploy contracts, or build the local signer.

Service A requires each end user to enroll their agent with an owner-wallet
signature; the operator then grants resource permissions. Service B requires
wallet registration and associates an authenticated agent through its onchain
`owner()`. Service-local state resets on restart; onchain identities persist.
The legacy local-chain launcher is available explicitly as `npm run demo:hardhat`.

### Use the skill in Codex or Claude Code

Installing the skill and connecting the MCP are **two separate steps**. The skill
is instructions for the agent; MCP and the hardware signer run locally on macOS
or Windows. A GitHub URL alone cannot launch them. For a fresh machine, clone the
public repository into a stable location and build the local components:

```sh
git clone https://github.com/ryuux05/eth-tokyo-2026.git
cd eth-tokyo-2026
npm ci
npm run build:mcp
npm run build:portal
npm run build:signer
npm run init:mcp
```

Keep this checkout: the MCP registration points to its built files. `init:mcp`
prints `MCP_CONFIG_PATH`, creates a private Sepolia config, and creates no key or
identity. Do not block init on a sandboxed hardware `availability` result.
Windows installs the bundled verified executable and needs no Go compiler.
To run the optional Service A/B workbench, use another terminal:

```sh
npm run demo
```

For a session **inside this checkout**, the skills are already installed at the
repository level: [Codex loads `.agents/skills`](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills)
and [Claude Code loads `.claude/skills`](https://code.claude.com/docs/en/skills#choose-where-skills-load).
Do not install a second personal copy for that same session.

For a session **in another project**, install the skill personally first:

- Codex: in a Codex session, ask
  `$skill-installer Install the skill from https://github.com/ryuux05/eth-tokyo-2026/tree/main/.agents/skills/agentic-world`.
  This public GitHub URL was tested with the bundled installer. It installs under
  `$CODEX_HOME/skills` (normally `~/.codex/skills`); Codex also recognizes
  manually placed personal skills under `~/.agents/skills`. Start a new Codex
  session if the skill does not appear.
- Claude Code: with the clone as your current directory, run:

  ```sh
  mkdir -p "$HOME/.claude/skills"
  ln -s "$(pwd -P)/.claude/skills/agentic-world" "$HOME/.claude/skills/agentic-world"
  ```

  The symlink makes `/agentic-world` available in other projects and updates
  with your clone. If that destination already exists, inspect it before
  replacing anything. [Claude Code supports personal and symlinked skills](https://code.claude.com/docs/en/skills#choose-where-skills-load).

Next, say `agentic-world:init` to the installed skill to register the MCP, or
register it manually below. Replace the placeholders with the absolute
`MCP_CONFIG_PATH` from init and this checkout's absolute server path. Inspect
existing registrations first and reuse a matching one.

For **Codex**:

```sh
codex mcp add agentic-world --env "AGENTIC_WORLD_CONFIG=<absolute-config-path>" -- node "<absolute-checkout>/dist/mcp/server.js"
codex mcp list
```

For **Claude Code inside this checkout**, use a local-scope entry with absolute
paths. It takes priority over the generic project `.mcp.json` entry:

```sh
claude mcp add --scope local --transport stdio agentic-world --env "AGENTIC_WORLD_CONFIG=<absolute-config-path>" -- node "<absolute-checkout>/dist/mcp/server.js"
claude mcp list
```

For **Claude Code in another project**, register a user-scoped server instead
of relying on this repo's `.mcp.json`:

```sh
claude mcp add --scope user --transport stdio agentic-world --env "AGENTIC_WORLD_CONFIG=<absolute-config-path>" -- node "<absolute-checkout>/dist/mcp/server.js"
claude mcp list
```

Start a new Codex or Claude session, check that `agentic_identity` is available,
then say `agentic-world:create -a "Research"`. The MCP creates or reuses a local
hardware P-256 key and opens a temporary localhost page in your default browser.
Connect a MetaMask-compatible wallet on **Sepolia (11155111)** with Sepolia ETH
to pay for the factory transaction. **You** choose the
human owner account and approve in the wallet; the MCP never sees your wallet
key or submits the transaction. The page verifies the account and reports
`0xAGENT` back to the agent. For a personal skill used outside this checkout,
give the agent the printed Service A or B URL and its expected audience
(`https://service-a.example` or `https://service-b.example` for this loopback
workbench). The default local signer label is `agentic-world-sepolia`.
Use `agentic-world:list`, `agentic-world:portal`, `agentic-world:rotate`, or
`agentic-world:revoke` to manage your identities. See the [MCP guide](docs/MCP.md)
and [local signer guide](docs/LOCAL-SIGNER.md).

The service operator key is **not** in the skill or MCP config; keep it in the
Service A operator page only. The full portal is optional.

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
