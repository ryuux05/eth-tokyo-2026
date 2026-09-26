// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccountERC7579Hooked} from
    "@openzeppelin/contracts/account/extensions/draft-AccountERC7579Hooked.sol";
import {IEntryPoint, PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {IERC7579Validator, MODULE_TYPE_VALIDATOR, MODULE_TYPE_HOOK, VALIDATION_FAILED} from
    "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {Mode} from "@openzeppelin/contracts/account/utils/draft-ERC7579Utils.sol";
import {AgentValidator} from "./AgentValidator.sol";
import {AgentPolicyHook} from "./AgentPolicyHook.sol";
import {PolicyEngine} from "./PolicyEngine.sol";

/// @notice ERC-4337 / ERC-7579 agent identity. The factory deploys initialized ERC-1167 clones.
/// @dev The owner is fixed after bootstrap; the operating validator cannot configure modules or policy.
contract AgentAccount4337 is AccountERC7579Hooked {
    address public immutable factory;
    AgentValidator public immutable agentValidator;
    AgentPolicyHook public immutable policyHook;
    IEntryPoint private immutable _entryPoint;

    address private _owner;
    uint64 private _createdAt;

    error NotFactory();
    error AlreadyInitialized();
    error InvalidOwner();
    error NotOwner();
    error ModuleConfigurationLocked();
    error UnsupportedExecutionMode();

    event AgentInitialized(address indexed agent, address indexed owner, address indexed authenticator);

    constructor(address factory_, AgentValidator validator_, AgentPolicyHook hook_, IEntryPoint entryPoint_) {
        require(factory_ != address(0) && address(validator_) != address(0) && address(hook_) != address(0) &&
            address(entryPoint_) != address(0), InvalidOwner());
        factory = factory_;
        agentValidator = validator_;
        policyHook = hook_;
        _entryPoint = entryPoint_;
    }

    modifier onlyOwner() {
        if (_owner == address(0) || msg.sender != _owner) revert NotOwner();
        _;
    }

    /// @dev Called atomically by the trusted factory after it deploys a clone.
    function initialize(address humanOwner, address initialAuthenticator) external {
        if (msg.sender != factory) revert NotFactory();
        if (_owner != address(0)) revert AlreadyInitialized();
        if (humanOwner == address(0) || humanOwner == address(this) || humanOwner == initialAuthenticator) {
            revert InvalidOwner();
        }
        _owner = humanOwner;
        _createdAt = uint64(block.timestamp);
        _installModule(MODULE_TYPE_VALIDATOR, address(agentValidator), abi.encode(initialAuthenticator));
        _installModule(MODULE_TYPE_HOOK, address(policyHook), "");
        emit AgentInitialized(address(this), humanOwner, initialAuthenticator);
    }

    function owner() external view returns (address) { return _owner; }
    function createdAt() external view returns (uint64) { return _createdAt; }
    function authenticator() external view returns (address) { return agentValidator.authenticator(address(this)); }
    function authenticationRevoked() external view returns (bool) {
        return agentValidator.authenticationRevoked(address(this));
    }
    function policy() external view returns (bytes memory) { return policyHook.policy(address(this)); }
    function policyHash() external view returns (bytes32) { return policyHook.policyHash(address(this)); }
    function policyRevision() external view returns (uint256) { return policyHook.policyRevision(address(this)); }
    function ownerApprovalNonce() external view returns (uint256) {
        return policyHook.ownerApprovalNonce(address(this));
    }
    function protocolVersion() external pure returns (uint64) { return 2; }
    function accountId() public pure override returns (string memory) { return "agentic.world.AgentAccount4337.v0"; }
    function entryPoint() public view override returns (IEntryPoint) { return _entryPoint; }

    function rotateAuthenticator(address signer) external onlyOwner {
        if (signer == _owner) revert InvalidOwner();
        agentValidator.rotateAuthenticator(signer);
    }
    function revokeAuthenticator() external onlyOwner { agentValidator.revokeAuthenticator(); }
    function restoreAuthenticator(address signer) external onlyOwner {
        if (signer == _owner) revert InvalidOwner();
        agentValidator.restoreAuthenticator(signer);
    }
    function setPolicy(bytes calldata encoded) external onlyOwner { policyHook.setPolicy(encoded); }
    function evaluateAction(address target, uint256 value, bytes calldata data)
        external view returns (PolicyEngine.Decision)
    {
        return policyHook.evaluateAction(address(this), target, value, data);
    }

    function supportsModule(uint256 moduleTypeId) public pure override returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR || moduleTypeId == MODULE_TYPE_HOOK;
    }

    function supportsExecutionMode(bytes32 mode) public pure override returns (bool) {
        return mode == bytes32(0); // single call, revert on error, no custom selector or payload
    }

    function installModule(uint256, address, bytes calldata) public pure override {
        revert ModuleConfigurationLocked();
    }

    function uninstallModule(uint256, address, bytes calldata) public pure override {
        revert ModuleConfigurationLocked();
    }

    function execute(bytes32 mode, bytes calldata executionCalldata) public payable override {
        if (!supportsExecutionMode(mode)) revert UnsupportedExecutionMode();
        super.execute(mode, executionCalldata);
    }

    function executeFromExecutor(bytes32, bytes calldata)
        public payable override returns (bytes[] memory)
    {
        revert ModuleConfigurationLocked();
    }

    /// @notice Use this ERC-4337 execution entrypoint when a policy requires an exact owner approval.
    function executeWithApproval(
        bytes32 mode, bytes calldata executionCalldata, uint256 nonce, uint64 deadline, bytes calldata signature
    ) external onlyEntryPoint {
        if (!supportsExecutionMode(mode)) revert UnsupportedExecutionMode();
        // The hook reads the whole calldata, checks the owner signature and consumes its nonce.
        nonce; deadline; signature;
        _execute(Mode.wrap(mode), executionCalldata);
    }

    /// @dev Fixed validator selection keeps the service's existing ERC-1271 envelope unchanged.
    function _validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, bytes calldata)
        internal override returns (uint256)
    {
        if (_owner == address(0)) return VALIDATION_FAILED;
        return IERC7579Validator(address(agentValidator)).validateUserOp(
            userOp, _signableUserOpHash(userOp, userOpHash)
        );
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) public view override returns (bytes4) {
        if (_owner == address(0)) return 0xffffffff;
        return IERC7579Validator(address(agentValidator)).isValidSignatureWithSender(msg.sender, hash, signature);
    }
}
