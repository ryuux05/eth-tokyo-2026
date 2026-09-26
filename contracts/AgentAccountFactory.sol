// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {IEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {AgentAccount4337} from "./AgentAccount4337.sol";
import {AgentValidator} from "./AgentValidator.sol";
import {AgentPolicyHook} from "./AgentPolicyHook.sol";

/// @notice Deploys immutable-implementation agent identities owned by the human transaction sender.
contract AgentAccountFactory {
    address public immutable implementation;
    AgentValidator public immutable validator;
    AgentPolicyHook public immutable policyHook;

    event AgentCreated(address indexed agent, address indexed owner, address indexed authenticator);

    constructor(IEntryPoint entryPoint) {
        validator = new AgentValidator();
        policyHook = new AgentPolicyHook();
        implementation = address(new AgentAccount4337(address(this), validator, policyHook, entryPoint));
    }

    function createAgent(address authenticator, bytes32 salt) external returns (address agent) {
        agent = Clones.cloneDeterministic(implementation, _salt(msg.sender, salt));
        AgentAccount4337(payable(agent)).initialize(msg.sender, authenticator);
        emit AgentCreated(agent, msg.sender, authenticator);
    }

    function predictAgent(address humanOwner, bytes32 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, _salt(humanOwner, salt));
    }

    function _salt(address humanOwner, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(humanOwner, salt));
    }
}
