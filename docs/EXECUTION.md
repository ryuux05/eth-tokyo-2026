# Policy-controlled USDC execution

Status: the updated stack is deployed and independently verified on Sepolia in transaction `0x6041588b9ef0b0d83de192b19d6b11ff5a0e35231679439f43fa4fdfc6e42fa8`, block 11788771. See [the deployment record](../deployments/sepolia-execution-v1.json). Actual transfers pass local EntryPoint/MCP tests; **live Pimlico submission and physical hardware execution remain untested**. Existing identities and Service C remain authentication/policy-preview demos. No USDC payment was submitted during deployment.

## What changes

- Contract: recipient-bound transfer rules, expiring P-256 UserOperation signatures, management-target protection, and exact token balance checks.
- Agent SDK: `createPaymentExecutor`, Pimlico RPC adapter, structured signing payload, durable-journal interface and independently verified receipts.
- Local signer: `sign-execution` accepts a bounded, single-call USDC transfer, reconstructs its digest and signs with Secure Enclave/TPM. No raw-digest MCP tool.
- MCP: `agentic_set_transfer_policy`, `agentic_pay_usdc`, `agentic_payment_status`.
- Service authentication API and middleware are unchanged. The agent still sends service HTTP requests itself; only payment submission goes from MCP to the bundler.

## Sepolia rollout gate

1. Completed: wallet-approved factory deployment, compiled transaction-input comparison, module-link verification, runtime hashes and `executionVersion() = 1`. Current creation/payment pins now point to that stack.
2. Publish the SDK/MCP/installer version and update services accepting new accounts. A service still enforces one chosen implementation: current by default, or an explicit `LEGACY_SEPOLIA_DEPLOYMENT.implementation` for old authentication-only identities. The local MCP/portal recognize both exact clone generations and preserve old IDs; creation uses the current factory. No unrecognized implementation or EIP-7702 delegation is accepted by these Sepolia checks.
3. Create a **new** agent from that factory. Existing ERC-1167 clones cannot upgrade in place. Keep old IDs and their status/history; transfer policies cannot be installed on the old deployed implementation.
4. Configure Pimlico's Sepolia bundler URL privately via `AGENTIC_WORLD_BUNDLER_RPC_URL` in the MCP environment, or `execution.bundlerRpcUrl` in its existing private config. Restart MCP. Do not commit or print API keys. A normal Ethereum RPC is still used for independent state/receipt reads.
5. Fund only the intended new agent with Sepolia ETH for gas and Sepolia USDC, then set its transfer policy with owner-wallet approval. No paymaster/sponsorship is requested.
6. Perform a small, explicitly requested transfer on Sepolia and verify its receipt, followed by an owner-required transfer. Hardware wallet/browser interactions and real bundler simulation still require this hands-on run.

USDC: `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` (6 decimals).
EntryPoint v0.8: `0x4337084d9e255ff0702461cf8895ce9e3b5ff108`.

## Tools

Example policy (replace the recipient with the owner's intended destination):

```js
agentic_set_transfer_policy({
  agentId: "0xAGENT",
  rules: [
    { recipient: "0xRECIPIENT", maxUsdc: "5", decision: "ALLOW" },
    { recipient: "0xRECIPIENT", maxUsdc: "20", decision: "REQUIRE_OWNER_SIGNATURE" }
  ]
})
```

First match wins: up to 5 is allowed, above 5 through 20 requires the owner, everything else is denied. This replaces the whole policy. Limits apply to each transfer, not a daily/cumulative budget. A payment must not be split to evade approval.

```js
agentic_pay_usdc({
  agentId: "0xAGENT", recipient: "0xRECIPIENT", amount: "1",
  requestId: "invoice-2026-0001"
})
agentic_payment_status({ requestId: "invoice-2026-0001" })
```

Direct `transfer(recipient, amount)` moves USDC from the agent, without token allowances. It does not call `purchaseCompute`, deliver Service C credits, or authorize service access. For owner-required actions, a compact browser page displays the exact amount, recipient, agent and expiry. The owner signs EIP-712; the owner does not submit the agent's operation.

## Safety and confirmation

The SDK hashes the complete EntryPoint v0.8 operation locally. The authenticator signs a separate `AgentExecution(bytes32 userOpHash,uint48 validUntil)` EIP-712 message in the agent domain. The signature envelope is 6-byte expiry followed by 64-byte P-256 r/s; EntryPoint enforces expiry. Authentication proof formats are unchanged. The old `signUserOperationHash` helper is for legacy secp256k1, not this P-256 execution path.

Owner approval binds agent, chain, token target, exact calldata hash, value, policy hash/revision, nonce and deadline. Updating policy invalidates a previously prepared approval. The onchain hook evaluates again during execution and requires exact sender decrease/recipient increase.

Native signer restrictions: single revert-on-error transfer, no native value, no factory/paymaster fields, no arbitrary token on Sepolia, no approve/transferFrom, positive amount and non-self recipient. Maximum gas is 5 million units, 100 gwei per unit, and 0.005 ETH total. Config can lower the total ceiling with `execution.maxGasCostWei`. UserOperations expire after at most 180 seconds in the SDK; the signer accepts at most 300 seconds.

The MCP serializes payments using a private disk lock and journals the signed operation before first broadcast. A stable request ID cannot be reused for another intent. Duplicate calls reconcile status without sending again; timeouts produce UNKNOWN, not FAILED/paid. SUBMITTED is not paid. Only an independently read chain receipt with the exact EntryPoint operation success **and** expected USDC Transfer yields CONFIRMED. This is receipt-level confirmation, not economic finality; reorg/finality handling remains a production-hardening task.

The local `<config>.payments.json` contains private payment history and signed operations; keep it private. If a process crashes, a stale lock intentionally blocks new payments. Confirm no MCP payment process is active, back up and inspect the journal and chain hashes, then remove only that lock to permit status reconciliation. Never delete the journal, replay an operation manually, or create a new request ID to resolve an unknown outcome.

## Verification

`test/Payments.ts`: actual token movements, owner-required branch, denial, wrong recipient, changed policy, expired/replayed signatures and ambiguous-broadcast reconciliation.
`test/McpPayments.ts`: MCP tools, policy transaction, local signer protocol, bundler JSON-RPC fixture, owner signature page and independently checked balances.
`test/PaymentApproval.ts`: wrong origin/signer/approval rejection, cancellation and persistent exclusive journal.
`test/ExecutionSignerVectors.ts`: Swift/Go hashes against viem and unsafe-input rejection, without accessing private keys.

These tests are not a contract audit, a physical TPM/Secure Enclave execution test, or evidence of live Pimlico compatibility. Contract deployment is complete; do not claim successful live payments until the remaining rollout checks pass.
