# Service C execution (agenticworld 0.0.4+)

Service C browser checks remain previews. An explicit user purchase request can
now execute `purchaseCompute(USDC, amount)` using the existing execution account.
No replacement account or contract deployment is required.

1. Select the agent, exact Service C contract and decimal amount the user requests.
   Read its policy with `agentic_policy_check`. DENY stops the purchase. Never
   replace or increase purchase limits to make a purchase succeed.
2. For insufficient allowance, obtain the owner's explicit authorization for
   bounded allowance setup. `agentic_enable_compute_allowance({agentId})` opens a
   wallet transaction that preserves version-1 purchase rules and adds only an
   owner-signature-required USDC approval rule. Existing conflicting approval
   rules and transfer-only policies are not overwritten.
3. Call `agentic_approve_compute_allowance({agentId, target, amount, requestId})`
   for exactly the authorized purchase amount. The owner signs the exact spender
   and amount. Check `agentic_payment_status({requestId})` until
   `allowanceConfirmed: true`. Approval is not payment; any unused allowance
   remains until consumed or revoked. Never grant an unlimited allowance.
4. Call `agentic_purchase_compute({agentId, target, amount, requestId})` with a
   separate stable request ID. An ALLOW purchase needs no spending signature;
   REQUIRE_OWNER_SIGNATURE opens the exact purchase approval in the browser.
5. Only `agentic_payment_status` with `purchaseConfirmed: true` proves completion:
   it verifies the EntryPoint operation, exact USDC transfer to the service, and
   the matching Purchased event in the same operation's receipt segment.

Never call purchase before confirming allowance. Never reissue an ambiguous
operation under a new request ID. A preparation FAILED with no operation hash
may be retried after fixing its reported prerequisite. This does not authorize
retrying SIGNED, SUBMITTED, UNKNOWN or a transaction that may have reached chain.
Retain IDs for both operations. No tokens move in response to a quote alone.
Direct `agentic_pay_usdc` is still a transfer, not a compute purchase.

Purchase targets must be deployed contracts permitted by the owner's onchain
policy; the SDK does not pin Service C addresses or runtime bytecode. The purchase
tool still requires the `purchaseCompute(address,uint256)` ABI and verifies the
exact USDC transfer and matching `Purchased` event before reporting success.
An allowed target is not a code audit: only authorize contracts the owner trusts.
macOS and Windows signers
accept only canonical zero-ETH USDC transfer/purchase calls and bounded approvals
wrapped in owner-approved execution. Authentication alone never authorizes a
purchase. Execution requires a configured bundler and agent-held ETH and USDC.
Purchased records a testnet purchase; it does not provision real compute.
