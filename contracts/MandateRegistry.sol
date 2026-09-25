// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice Shared principal-agent mandate, not a service permission registry.
/// @dev The principal registers by sending the transaction, so msg.sender is
///      the principal. The agent root EOA separately permits the pairing.
contract MandateRegistry is EIP712 {
    bytes32 private constant _REGISTRATION_TYPEHASH = keccak256(
        "AgentRegistration(address agent,address principal,uint256 nonce,uint64 deadline)"
    );

    mapping(address agent => address principal) private _principalOf;
    mapping(address agent => uint256 nonce) public nonceOf;

    error InvalidAgent();
    error AlreadyRegistered();
    error NotRegisteredPrincipal();
    error InvalidRegistrationNonce();
    error ExpiredAuthorization();
    error InvalidRootSignature();

    event MandateRegistered(address indexed agent, address indexed principal);
    event MandateRevoked(address indexed agent, address indexed principal);

    constructor() EIP712("Agentic World Mandate Registry", "1") {}

    function principalOf(address agent) external view returns (address) {
        return _principalOf[agent];
    }

    /// @notice Register a mandate with one owner transaction and an agent-root permit.
    function register(
        address agent,
        uint256 nonce,
        uint64 deadline,
        bytes calldata agentRootSignature
    ) external {
        if (agent == address(0) || agent == msg.sender) revert InvalidAgent();
        if (_principalOf[agent] != address(0)) revert AlreadyRegistered();
        if (nonce != nonceOf[agent]) revert InvalidRegistrationNonce();
        if (block.timestamp > deadline) revert ExpiredAuthorization();

        bytes32 structHash = keccak256(
            abi.encode(_REGISTRATION_TYPEHASH, agent, msg.sender, nonce, deadline)
        );
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(
            _hashTypedDataV4(structHash), agentRootSignature
        );
        if (error != ECDSA.RecoverError.NoError || recovered != agent) {
            revert InvalidRootSignature();
        }

        _principalOf[agent] = msg.sender;
        nonceOf[agent] = nonce + 1;
        emit MandateRegistered(agent, msg.sender);
    }

    function revoke(address agent) external {
        if (_principalOf[agent] != msg.sender) revert NotRegisteredPrincipal();
        delete _principalOf[agent];
        nonceOf[agent] += 1;
        emit MandateRevoked(agent, msg.sender);
    }
}
