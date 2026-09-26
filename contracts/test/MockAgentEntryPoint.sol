// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccount, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";

/// @dev Local caller-boundary fixture. It is NOT a bundler or a full ERC-4337 EntryPoint.
contract MockAgentEntryPoint {
    function validate(address account, PackedUserOperation calldata op, bytes32 hash) external returns (uint256) {
        return IAccount(account).validateUserOp(op, hash, 0);
    }

    function run(address account, bytes calldata callData) external {
        (bool ok, bytes memory result) = account.call(callData);
        if (!ok) assembly { revert(add(result, 32), mload(result)) }
    }
}
