# AgentAccount execution policy

Agentic World now has three related but distinct facts:

1. **Identity:** `0xAGENT` is the persistent agent address and verifies its operating authenticator.
2. **Mandate:** a principal independently registered the agent to act on their behalf.
3. **Execution policy:** the principal controls which onchain actions the operating authenticator may perform autonomously, which require an exact owner approval, and which are denied.

The execution policy does **not** grant access to a service's API or paid resources. Each service still checks its own subscriptions, ACLs, and agent-eligible routes. Conversely, a service granting an agent access cannot bypass this policy for an onchain action from `0xAGENT`.

This is the constrained v1 implementation of the supplied policy specification. The rules below describe the implemented format.

## Rule encoding and matching

The owner calls `0xAGENT.setPolicy(bytes)` directly. `msg.sender` must be the stored owner. The encoded policy is:

```solidity
abi.encode(uint8(1), Rule[] rules)

struct Rule {
    address target;
    bytes4 selector;
    address token;
    uint256 maxValue;
    uint256 maxAmount;
    Decision decision;
}

enum Decision { DENY, ALLOW, REQUIRE_OWNER_SIGNATURE }
```

The array order is meaningful: **first matching rule wins**. Every populated condition in a rule must match. All rules match an exact `target`, function `selector`, and native value at most `maxValue`. Empty calldata has selector `0x00000000`; 1–3 calldata bytes fail closed. A zero-selector rule matches only empty calldata. Unknown targets, selectors, or values above every matching threshold are `DENY`. `DENY` cannot be overridden by attaching an owner signature. If no policy is installed, all execution is denied.

For a native-only rule, `token = address(0)` and `maxAmount = 0`; the purchase selector cannot be used as a native-only rule. For a token rule, `token` is the expected ERC-20 address, `maxValue = 0`, and `maxAmount` is in token base units. The only supported token-aware call in v1 is `purchaseCompute(address token,uint256 amount)` on the exact configured `target`. The engine requires precisely 68 calldata bytes, checks its selector, decodes those two ABI arguments in their fixed positions, and compares both the token and amount. It never tries to infer token amounts from arbitrary calldata. During execution the account also compares its ERC-20 balance before and after the call and reverts if the target spent more of that token than the declared amount. A target contract must still implement trustworthy purchase behavior; the policy does not audit what it does with the payment or other assets.

The contract rejects unknown versions, malformed or noncanonical ABI encoding, zero targets, more than 32 rules, and policies larger than 8192 bytes. It stores the canonical bytes and exposes `policy()`, `policyHash()`, `policyRevision()`, `evaluateAction(...)`, and `ownerApprovalNonce()` at the agent address. Updating the policy increments its revision but does not change `0xAGENT`, its owner, authenticator, mandate, or service-side entitlements.

The agent SDK exports `Decision`, `TOKEN_PURCHASE_SELECTOR`, `encodePolicy(rules)`, `decodePolicy(bytes)`, and `ownerActionTypedData(action)`. The [owner registration page](PORTAL.md) uses these to build and read policy:

```ts
import { Decision, TOKEN_PURCHASE_SELECTOR, encodePolicy } from "agentic-world/agent";

const encoded = encodePolicy([
  { target: shop, selector: TOKEN_PURCHASE_SELECTOR, token: usdc, maxValue: 0n,
    maxAmount: 5_000_000n, decision: Decision.ALLOW },
  { target: shop, selector: TOKEN_PURCHASE_SELECTOR, token: usdc, maxValue: 0n,
    maxAmount: 100_000_000n, decision: Decision.REQUIRE_OWNER_SIGNATURE },
]);
// The connected owner wallet sends 0xAGENT.setPolicy(encoded).
```

The example uses a 6-decimal demo USDC token: 2 tokens match the first rule, while 20 tokens reach the second. This is a **per-call** ceiling, not a cumulative budget. A separate exact-action owner approval can allow an ERC-20 allowance call so the pinned purchase target can pull tokens; token purchase rules do not themselves create an allowance.

## Execution and exact-action approval

`execute(target,value,data,approval)` may be called only by the current operating authenticator while authentication is active. It spends native value already held by `0xAGENT`, or makes the supported token-purchase call with `value = 0`. Anyone may fund the account through its payable `receive()` function. The operating signer cannot call `setPolicy` or owner-only lifecycle functions.

For `ALLOW`, execution needs no owner approval. For `REQUIRE_OWNER_SIGNATURE`, the contract checks a signature against the **current stored owner** using OpenZeppelin `SignatureChecker`, so an EOA or ERC-1271 contract owner can approve. The signature covers this EIP-712 message under the existing `Agentic World AgentAccount` / `1` domain with `verifyingContract = 0xAGENT`:

```text
OwnerActionApproval(
  address agent,
  uint256 chainId,
  address target,
  uint256 value,
  bytes32 dataHash,    // keccak256(data)
  bytes32 policyHash,  // prevents stale approval across policy changes
  uint256 policyRevision, // invalidates approvals even if old bytes are restored
  uint256 nonce,
  uint64 deadline
)
```

The approval nonce is separate from service challenges and account bootstrap nonces. It advances before the external target call. A failed transaction rolls the increment back. Reentrancy is blocked during execution. The contract checks policy **before** any approval, so even a valid owner signature cannot bypass `DENY`.

The human should inspect the exact target, value, calldata, policy hash and revision, agent address, chain, nonce, and deadline before signing. An agent runtime must not hold the human signing key. Signing a service authentication proof is not an owner action approval.

## Limits and threat model

This policy constrains the **operating authenticator's `execute` path**, not the root EOA key. Under EIP-7702, the root key retains ultimate authority to submit its own transactions and alter or clear delegation; no delegated contract can promise to restrain a compromised root key. Keep that key out of the runtime. Services independently pin the expected implementation and validate the mandate registry when relevant.

Only native `value` and the declared and net-spent amount of the exact token in the supported `purchaseCompute(address,uint256)` call are bounded in v1. Gas, ERC-20 `approve` amounts, arbitrary token calls, other token balances, cumulative spend, and downstream target behavior are not analyzed. The contract performs a normal `call`, not a `delegatecall`, but an approved target may itself call others. Narrowly pin targets and selectors. This is a hackathon prototype, not an audit or a universal spending firewall.

The tests cover default deny, owner-only updates, malformed and unknown policy rejection, first-match thresholds, selector-aware token decoding, overcharge rejection, 2/20 demo token execution, exact-action approvals, expiry, nonce replay, owner mismatch, policy-update invalidation, authenticator rotation, and ERC-1271 contract owners. Foundry is not installed in this workspace; these are Hardhat EIP-7702 tests.
