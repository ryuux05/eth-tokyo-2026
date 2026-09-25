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
        uint256 maxValue;
        Decision decision;
    }

    uint8 internal constant VERSION = 1;
    uint256 internal constant MAX_RULES = 32;
    uint256 internal constant MAX_POLICY_BYTES = 8192;

    error InvalidPolicy();

    /// @dev Versioned ABI envelope: abi.encode(uint8(1), Rule[]).
    ///      Rule order is significant; the first matching rule wins.
    function validate(bytes calldata encoded) internal pure {
        if (encoded.length == 0 || encoded.length > MAX_POLICY_BYTES) revert InvalidPolicy();
        (uint8 version, Rule[] memory rules) = abi.decode(encoded, (uint8, Rule[]));
        if (version != VERSION || rules.length > MAX_RULES) revert InvalidPolicy();
        if (keccak256(encoded) != keccak256(abi.encode(version, rules))) revert InvalidPolicy();
        for (uint256 i; i < rules.length; ++i) {
            if (rules[i].target == address(0)) revert InvalidPolicy();
        }
    }

    function evaluate(
        bytes storage encoded,
        address target,
        uint256 value,
        bytes calldata data
    ) internal view returns (Decision) {
        if (encoded.length == 0 || data.length > 0 && data.length < 4) return Decision.DENY;
        (uint8 version, Rule[] memory rules) = abi.decode(encoded, (uint8, Rule[]));
        if (version != VERSION) return Decision.DENY;
        bytes4 selector = data.length == 0 ? bytes4(0) : bytes4(data[:4]);
        for (uint256 i; i < rules.length; ++i) {
            Rule memory rule = rules[i];
            if (
                rule.target == target && rule.selector == selector &&
                value <= rule.maxValue && (selector != bytes4(0) || data.length == 0)
            ) return rule.decision;
        }
        return Decision.DENY;
    }
}
