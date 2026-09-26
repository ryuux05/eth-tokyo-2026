# Local end-to-end demo

Run the Hardhat JSON-RPC node in one terminal:

```sh
npx hardhat node --hostname 127.0.0.1 --port 8545
```

In another terminal:

```sh
npm install
npm run demo:local
```

The script deploys the official EntryPoint v0.8 implementation, `AgentAccountFactory`,
an initialized `0xAGENT` clone, and a demo policy target on chain 31337. The
Hardhat owner wallet sets an `ALLOW` policy and funds the agent's EntryPoint
deposit. An ephemeral operating key signs a UserOperation, which is submitted
directly to `handleOps` and executes the allowed target call.

The script then starts independent local service and agent processes, plus a
local stdio MCP process for the MCP checks:

| Process | SDK use | Service-owned decision |
| --- | --- | --- |
| Service A | `AgenticWorld` in `owner` mode | The verified `owner()` maps to a simulated paid user; `/private/report` is allowed. |
| Service B | `AgenticWorld` in `manual` mode | The agent ID is enrolled locally; `/private/compute` is allowed, but `/private/admin` is denied. |
| Agent | `createAgentSdk` | Signs each exact HTTP request with its own nonce and audience, then calls both services. |
| Agentic World MCP | Local stdio server using a demo key adapter | Exposes identity, URL-based service request, and read-only policy preview tools to an MCP client. The demo maps two HTTPS audiences to loopback listeners. |

Expected checks: A and B return 200 for their allowed resources; a Service A
proof and session fail at B with 401; B returns 403 for `/private/admin` even
after valid authentication; a repeated signed request returns 401. An MCP
client discovers the seven tools, checks owner transaction preparation and the P-256 bootstrap path, calls both services by URL, reuses a service-scoped
session, and confirms a route absent from the local demo transport map fails locally. Finally,
the owner revokes the operating key onchain. Fresh signed requests then return
401 at **both** services; the MCP server also refuses new authentication. The
service SDK explicitly bypasses its RPC client's
cached block height when checking a fresh proof; the regression test covers
that freshness requirement.

The two services have separate in-memory enrollment, nonce, session and route
data. Neither calls an Agentic World authentication backend. They independently
check the same onchain agent identity and current authenticator. The script
prints deployment addresses and transaction hashes, then shuts down the
temporary HTTP services; the Hardhat node and deployed contracts persist until
you stop or restart the node.

This is a local development demo, **not** a public deployment: Hardhat owner
keys are public, the operating private key is ephemeral and passed to the demo
agent process, stores are not durable, paid status is simulated, and the signed
HTTPS audiences use loopback HTTP transport only for this test. A bundler, KMS,
TLS, durable stores, real payment integration, and security review remain open.
