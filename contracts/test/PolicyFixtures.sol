// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentAccount} from "../AgentAccount.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PolicyDemoUSDC is ERC20 {
    constructor() ERC20("Demo USD Coin", "dUSDC") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
}

/// @dev Test/demo receiver. No resource authorization is implied by this call.
contract PolicyActionTarget {
    uint256 public calls;
    uint256 public lastValue;
    bytes32 public lastLabel;
    address public lastToken;
    uint256 public lastAmount;
    uint256 public extraCharge;

    function setExtraCharge(uint256 amount) external { extraCharge = amount; }

    function purchase(bytes32 label) external payable returns (uint256) {
        calls += 1;
        lastValue = msg.value;
        lastLabel = label;
        return calls;
    }

    function purchaseCompute(address token, uint256 amount) external returns (uint256) {
        require(IERC20(token).transferFrom(msg.sender, address(this), amount + extraCharge), "TRANSFER_FAILED");
        calls += 1;
        lastToken = token;
        lastAmount = amount;
        return calls;
    }
}

/// @dev Test fixture demonstrating direct contract-owner initialization and ERC-1271 approval.
contract PolicyContractOwner is IERC1271 {
    address public immutable signer;
    error NotSigner();

    constructor(address initialSigner) {
        signer = initialSigner;
    }

    function initializeAgent(address agent, address authenticator, uint256 nonce, uint64 deadline, bytes calldata permit)
        external
    {
        if (msg.sender != signer) revert NotSigner();
        AgentAccount(payable(agent)).initialize(authenticator, nonce, deadline, permit);
    }

    function setAgentPolicy(address agent, bytes calldata encoded) external {
        if (msg.sender != signer) revert NotSigner();
        AgentAccount(payable(agent)).setPolicy(encoded);
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(digest, signature);
        return error == ECDSA.RecoverError.NoError && recovered == signer
            ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}
