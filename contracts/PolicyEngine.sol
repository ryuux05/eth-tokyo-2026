// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Small, deterministic, first-match execution policy for AgentAccount.
library PolicyEngine {
    enum Decision {
        DENY,
        ALLOW,
        REQUIRE_OWNER_SIGNATURE
    }

    struct Rule {
        address target;
        bytes4 selector;
        address token;
        uint256 maxValue;
        uint256 maxAmount;
        Decision decision;
    }

    struct RuleV2 {
        address target;
        bytes4 selector;
        address token;
        uint256 maxValue;
        uint256 maxAmount;
        Decision decision;
        address recipient;
    }

    bytes4 internal constant TOKEN_PURCHASE_SELECTOR = bytes4(keccak256("purchaseCompute(address,uint256)"));
    bytes4 internal constant TRANSFER_SELECTOR = bytes4(keccak256("transfer(address,uint256)"));
    uint8 internal constant VERSION = 1;
    uint256 internal constant MAX_RULES = 32;
    uint256 internal constant MAX_POLICY_BYTES = 8192;

    error InvalidPolicy();

    /// @dev Versioned ABI envelope: abi.encode(uint8(1), Rule[]).
    ///      Rule order is significant; the first matching rule wins.
    function validate(bytes calldata encoded) internal pure {
        if (encoded.length == 0 || encoded.length > MAX_POLICY_BYTES) revert InvalidPolicy();
        uint8 envelope = abi.decode(encoded, (uint8));
        if (envelope == 2) {
            (, RuleV2[] memory transferRules) = abi.decode(encoded, (uint8, RuleV2[]));
            if (transferRules.length > MAX_RULES || keccak256(encoded) != keccak256(abi.encode(uint8(2), transferRules))) revert InvalidPolicy();
            for (uint256 i; i < transferRules.length; ++i) {
                RuleV2 memory rule = transferRules[i];
                // Version 2 is deliberately transfer-only: no approve, transferFrom,
                // arbitrary calls, wildcards, delegatecall or unlimited recipients.
                if (rule.target == address(0) || rule.target != rule.token || rule.recipient == address(0) ||
                    rule.selector != TRANSFER_SELECTOR || rule.maxValue != 0 || rule.maxAmount == 0) revert InvalidPolicy();
            }
            return;
        }
        (uint8 version, Rule[] memory rules) = abi.decode(encoded, (uint8, Rule[]));
        if (version != VERSION || rules.length > MAX_RULES) revert InvalidPolicy();
        if (keccak256(encoded) != keccak256(abi.encode(version, rules))) revert InvalidPolicy();
        for (uint256 i; i < rules.length; ++i) {
            if (rules[i].target == address(0)) revert InvalidPolicy();
            if (rules[i].token == address(0)) {
                if (rules[i].maxAmount != 0 || rules[i].selector == TOKEN_PURCHASE_SELECTOR || rules[i].selector == TRANSFER_SELECTOR) {
                    revert InvalidPolicy();
                }
            } else if (rules[i].selector != TOKEN_PURCHASE_SELECTOR || rules[i].maxValue != 0) {
                revert InvalidPolicy();
            }
        }
    }

    function evaluate(
        bytes storage encoded,
        address target,
        uint256 value,
        bytes memory data
    ) internal view returns (Decision) {
        if (encoded.length == 0 || data.length > 0 && data.length < 4) return Decision.DENY;
        if (abi.decode(encoded, (uint8)) == 2) {
            (, RuleV2[] memory rulesV2) = abi.decode(encoded, (uint8, RuleV2[]));
            (bool transfer, address recipient, uint256 amount) = transferDetails(data);
            if (!transfer || value != 0 || amount == 0) return Decision.DENY;
            for (uint256 i; i < rulesV2.length; ++i) {
                RuleV2 memory rule = rulesV2[i];
                if (rule.target == target && rule.token == target && rule.recipient == recipient && amount <= rule.maxAmount)
                    return rule.decision;
            }
            return Decision.DENY;
        }
        (uint8 version, Rule[] memory rules) = abi.decode(encoded, (uint8, Rule[]));
        if (version != VERSION) return Decision.DENY;
        bytes4 selector = data.length == 0 ? bytes4(0) : bytes4(data);
        (bool supportedPurchase, address actionToken, uint256 actionAmount) = tokenPurchaseDetails(data);
        for (uint256 i; i < rules.length; ++i) {
            Rule memory rule = rules[i];
            if (rule.target != target || rule.selector != selector || value > rule.maxValue) continue;
            if (selector == bytes4(0) && data.length != 0) continue;
            if (rule.token != address(0)) {
                // The only supported token-aware action is the demo purchase ABI.
                // Never infer token amounts from arbitrary calldata or downstream calls.
                if (!supportedPurchase || value != 0 || actionToken != rule.token || actionAmount > rule.maxAmount) {
                    continue;
                }
            }
            return rule.decision;
        }
        return Decision.DENY;
    }

    function tokenPurchaseDetails(bytes memory data)
        internal pure returns (bool supported, address token, uint256 amount)
    {
        if (data.length != 68 || bytes4(data) != TOKEN_PURCHASE_SELECTOR) return (false, address(0), 0);
        uint256 tokenWord;
        assembly {
            tokenWord := mload(add(data, 36))
            amount := mload(add(data, 68))
        }
        if (tokenWord >> 160 != 0) return (false, address(0), 0);
        return (true, address(uint160(tokenWord)), amount);
    }

    function transferDetails(bytes memory data) internal pure returns (bool supported, address recipient, uint256 amount) {
        if (data.length != 68 || bytes4(data) != TRANSFER_SELECTOR) return (false, address(0), 0);
        uint256 recipientWord;
        assembly ("memory-safe") {
            recipientWord := mload(add(data, 36))
            amount := mload(add(data, 68))
        }
        if (recipientWord >> 160 != 0 || recipientWord == 0) return (false, address(0), 0);
        return (true, address(uint160(recipientWord)), amount);
    }
}
