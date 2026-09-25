// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AgentAccount} from "../AgentAccount.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Test/demo receiver. No resource authorization is implied by this call.
contract PolicyActionTarget {
    uint256 public calls;
    uint256 public lastValue;
    bytes32 public lastLabel;

    function purchase(bytes32 label) external payable returns (uint256) {
        calls += 1;
        lastValue = msg.value;
        lastLabel = label;
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
