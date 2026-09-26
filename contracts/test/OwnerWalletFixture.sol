// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Test only: reproduce a wallet wrapping a call instead of submitting it directly.
contract OwnerWalletFixture {
    address public immutable controller = msg.sender;

    function forward(address target, bytes calldata data) external returns (bytes memory result) {
        require(msg.sender == controller, "Not controller");
        bool success;
        (success, result) = target.call(data);
        if (!success) assembly ("memory-safe") { revert(add(result, 32), mload(result)) }
    }
}
