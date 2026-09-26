// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7579Hook, MODULE_TYPE_HOOK} from "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {Bytes} from "@openzeppelin/contracts/utils/Bytes.sol";
import {PolicyEngine} from "./PolicyEngine.sol";

interface IAgentPolicyAccount {
    function owner() external view returns (address);
    function agentValidator() external view returns (address);
}

/// @notice ERC-7579 execution hook. Each agent account has its own owner-defined policy.
contract AgentPolicyHook is IERC7579Hook {
    using Bytes for bytes;
    using PolicyEngine for bytes;

    bytes4 private constant _EXECUTE = bytes4(keccak256("execute(bytes32,bytes)"));
    bytes4 private constant _EXECUTE_APPROVED =
        bytes4(keccak256("executeWithApproval(bytes32,bytes,uint256,uint64,bytes)"));
    bytes32 private constant _OWNER_ACTION_TYPEHASH = keccak256(
        "OwnerActionApproval(address agent,uint256 chainId,address target,uint256 value,bytes32 dataHash,bytes32 policyHash,uint256 policyRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("Agentic World AgentAccount");
    bytes32 private constant _VERSION_HASH = keccak256("1");

    struct PolicyState {
        bytes policy;
        bytes32 policyHash;
        uint256 revision;
        uint256 approvalNonce;
        bool installed;
        bool executing;
    }

    mapping(address account => PolicyState) private _states;

    error NotInstalled();
    error AlreadyInstalled();
    error UnsupportedExecution();
    error PolicyDenied();
    error OwnerSignatureRequired();
    error InvalidOwnerSignature();
    error ApprovalExpired();
    error InvalidApprovalNonce();
    error ReentrantExecution();
    error TokenSpendExceeded();

    event PolicyUpdated(address indexed account, bytes32 indexed policyHash, uint256 revision);

    function onInstall(bytes calldata) external {
        if (_states[msg.sender].installed) revert AlreadyInstalled();
        _states[msg.sender].installed = true;
    }

    function onUninstall(bytes calldata) external pure {
        revert NotInstalled(); // The v0 account does not permit removing its policy hook.
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_HOOK;
    }

    /// @dev Called only through an owner-checked function on the account.
    function setPolicy(bytes calldata newPolicy) external {
        PolicyState storage state = _installedState(msg.sender);
        PolicyEngine.validate(newPolicy);
        state.policy = newPolicy;
        state.policyHash = keccak256(newPolicy);
        state.revision += 1;
        emit PolicyUpdated(msg.sender, state.policyHash, state.revision);
    }

    function policy(address account) external view returns (bytes memory) { return _states[account].policy; }
    function policyHash(address account) external view returns (bytes32) { return _states[account].policyHash; }
    function policyRevision(address account) external view returns (uint256) { return _states[account].revision; }
    function ownerApprovalNonce(address account) external view returns (uint256) { return _states[account].approvalNonce; }

    function evaluateAction(address account, address target, uint256 value, bytes calldata data)
        external view returns (PolicyEngine.Decision)
    {
        if (!_states[account].installed || _isManagementTarget(account, target)) return PolicyEngine.Decision.DENY;
        return _states[account].policy.evaluate(target, value, data);
    }

    function preCheck(address, uint256, bytes calldata msgData) external returns (bytes memory hookData) {
        PolicyState storage state = _installedState(msg.sender);
        if (state.executing) revert ReentrantExecution();
        if (msgData.length < 4) revert UnsupportedExecution();
        bytes4 selector = bytes4(msgData[:4]);
        bytes32 mode;
        bytes memory execution;
        uint256 nonce;
        uint64 deadline;
        bytes memory signature;
        if (selector == _EXECUTE) {
            (mode, execution) = abi.decode(msgData[4:], (bytes32, bytes));
        } else if (selector == _EXECUTE_APPROVED) {
            (mode, execution, nonce, deadline, signature) = abi.decode(msgData[4:], (bytes32, bytes, uint256, uint64, bytes));
        } else {
            revert UnsupportedExecution();
        }
        // v0 supports only ERC-7579 single-call, revert-on-error mode.
        if (mode != bytes32(0) || execution.length < 52) revert UnsupportedExecution();
        address target;
        uint256 value;
        assembly {
            target := shr(96, mload(add(execution, 32)))
            value := mload(add(execution, 52))
        }
        if (_isManagementTarget(msg.sender, target)) revert PolicyDenied();
        bytes memory callData = execution.slice(52);
        PolicyEngine.Decision decision = state.policy.evaluate(target, value, callData);
        if (decision == PolicyEngine.Decision.DENY) revert PolicyDenied();
        if (decision == PolicyEngine.Decision.REQUIRE_OWNER_SIGNATURE) {
            if (selector != _EXECUTE_APPROVED) revert OwnerSignatureRequired();
            _checkOwnerApproval(state, target, value, callData, nonce, deadline, signature);
        }
        state.executing = true;
        (bool purchase, address token, uint256 amount) = PolicyEngine.tokenPurchaseDetails(callData);
        if (purchase) return abi.encode(token, IERC20(token).balanceOf(msg.sender), amount);
        return abi.encode(address(0), uint256(0), uint256(0));
    }

    function postCheck(bytes calldata hookData) external {
        PolicyState storage state = _installedState(msg.sender);
        if (!state.executing) revert UnsupportedExecution();
        (address token, uint256 balanceBefore, uint256 maxSpent) = abi.decode(hookData, (address, uint256, uint256));
        if (token != address(0)) {
            uint256 balanceAfter = IERC20(token).balanceOf(msg.sender);
            if (balanceAfter < balanceBefore && balanceBefore - balanceAfter > maxSpent) revert TokenSpendExceeded();
        }
        state.executing = false;
    }

    function _installedState(address account) private view returns (PolicyState storage state) {
        state = _states[account];
        if (!state.installed) revert NotInstalled();
    }

    // Module calls execute with the account as msg.sender. Letting an operating
    // key call these modules would bypass the account's onlyOwner wrappers.
    function _isManagementTarget(address account, address target) private view returns (bool) {
        return target == address(0) || target == account || target == address(this) ||
            target == IAgentPolicyAccount(account).agentValidator();
    }

    function _checkOwnerApproval(
        PolicyState storage state, address target, uint256 value, bytes memory callData,
        uint256 nonce, uint64 deadline, bytes memory signature
    ) private {
        if (block.timestamp > deadline) revert ApprovalExpired();
        if (nonce != state.approvalNonce) revert InvalidApprovalNonce();
        bytes32 structHash = keccak256(abi.encode(
            _OWNER_ACTION_TYPEHASH, msg.sender, block.chainid, target, value, keccak256(callData),
            state.policyHash, state.revision, nonce, deadline
        ));
        bytes32 domain = keccak256(abi.encode(
            _DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, msg.sender
        ));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", domain, structHash));
        if (!SignatureChecker.isValidSignatureNow(IAgentPolicyAccount(msg.sender).owner(), digest, signature)) {
            revert InvalidOwnerSignature();
        }
        state.approvalNonce += 1;
    }
}
