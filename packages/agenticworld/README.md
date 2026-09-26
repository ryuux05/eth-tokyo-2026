# Agentic World installer

Publication status: prepared for npm; **not published yet**. Do not advertise the
unqualified npm command as available until the package has been published under
the project's controlled npm account.

After publication:

```sh
npx agenticworld install
npx agenticworld install --client codex
npx agenticworld install --client claude --rpc https://your-sepolia-rpc
```

This installs the skill and local MCP for detected/selected clients. Restart the
client and say `agentic-world:create -a "My agent"`. Init never provisions keys,
opens a wallet, or sends a transaction. The create tool handles those separately
with owner approval. Only macOS Secure Enclave and native Windows TPM are
supported; Linux/WSL has no software-key fallback.

The package includes compiled MCP/SDK/portal files, browser approval pages,
Swift signer source, and checksum-verified Windows x64/ARM64 executables.
It installs a persistent copy under the OS's AgenticWorld application-data
directory, not the disposable npx cache. Runtime dependencies only: no git,
Hardhat, Next.js, TypeScript, or Go installation. macOS still needs Apple Swift
tools (`xcode-select --install` if missing).

Existing `config.json` is reused, including revoked identities and signer paths.
Existing skill copies are reused without merging/replacing their instructions.
Visible duplicate skill names, broken skill folders, and conflicting MCP
registrations stop installation with an explanation. The installer does not
delete skills in other projects or migrate an existing checkout registration.
Claude uses user scope normally and local scope when this project's `.mcp.json`
would shadow it. It does not change project approval/disabled settings.

RPC defaults to public Sepolia. An explicitly requested endpoint update is:

```sh
npx agenticworld install --rpc https://your-sepolia-rpc --update-rpc
```

Stop the MCP first. Use `AGENTIC_WORLD_RPC_URL` for private endpoint credentials.
Chain ID must be 11155111; validation failure never changes the config. No
hardware availability probe is used as an init gate: sandbox restrictions can
produce false negatives. Creation still requires actual hardware signing.

## Add a bundler after init

Bundler setup is optional; authentication and policy previews work without it.
After publication, stop/disconnect the MCP and run in your own terminal:

```sh
npx agenticworld configure-bundler
```

Paste the Pimlico Sepolia RPC URL into the hidden prompt. Alternatively, provide
`AGENTIC_WORLD_BUNDLER_RPC_URL` through your local environment. `--bundler-rpc`
is supported, but a credential-bearing URL on the command line enters shell history.
Use `--config <absolute-path>` for a non-default MCP config; otherwise the command
uses `AGENTIC_WORLD_CONFIG` or the normal platform config location.

It checks the chain, EntryPoint v0.8 support and Pimlico fee API, then saves only
the bundler endpoint. Run it again to replace the endpoint. Restart the MCP after
saving. This does not sign or submit a transaction. Existing identities and gas
limits are preserved. Before publication, use `npm run configure:bundler` from
the source checkout. The skill prompt is `agentic-world:configure-bundler`.

## Build and check before publication

From the repository root:

```sh
npm ci
npm run build:installer
npm run test:installer
npm pack ./packages/agenticworld
```

Test the tarball without publishing:

```sh
npm exec --package ./agenticworld-0.0.2.tgz -- agenticworld --help
# This next command installs into your real user profile; run only intentionally.
npm exec --package ./agenticworld-0.0.2.tgz -- agenticworld install --client codex
```

Inspect `npm pack --dry-run ./packages/agenticworld` before releasing. The
prepack check rejects missing runtime/browser/signer assets. Do not include
local config, signer keys, build caches, or demo state. To publish, an authorized
maintainer must first confirm npm ownership, authenticate, then run
`npm publish ./packages/agenticworld --access public` (may require npm 2FA).
This package is separate from the root SDK package and does not change its exports.

Rerunning the same version skips completed runtime/signer builds. If a build or
RPC step fails, fix the reported requirement and rerun. If a process was killed,
remove its `.install.lock` only after confirming no installer is still running.
Upgrading to another runtime version or moving an existing MCP registration
requires explicit reconciliation; there is no silent `--force` overwrite.
