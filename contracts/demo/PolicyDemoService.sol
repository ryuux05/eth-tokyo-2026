// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Testnet purchase target for demonstrating Agentic World's existing token policy ABI.
/// @dev The Service C web UI only previews policy; it never approves or purchases tokens.
contract PolicyDemoService {
    using SafeERC20 for IERC20;
    address public owner;
    event Purchased(address indexed agent, address indexed token, uint256 amount);

    constructor() { owner = msg.sender; }

    function purchaseCompute(address token, uint256 amount) external {
        require(amount > 0, "Zero amount");
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Purchased(msg.sender, token, amount);
    }

    /// @notice Only the wallet that deployed this test service can recover its receipts.
    function withdraw(address token, uint256 amount) external {
        require(msg.sender == owner, "Not owner");
        IERC20(token).safeTransfer(owner, amount);
    }
}
