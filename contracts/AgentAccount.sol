// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PolicyEngine} from "./PolicyEngine.sol";

/// @notice EIP-7702 implementation called at each persistent agent EOA address.
/// @dev It contains no global service permissions. State is stored at 0xAGENT.
contract AgentAccount is EIP712, IERC1271 {
    bytes4 private constant _VALID_SIGNATURE = 0x1626ba7e;
    bytes4 private constant _INVALID_SIGNATURE = 0xffffffff;

    bytes32 private constant _INITIALIZATION_TYPEHASH = keccak256(
        "AgentInitialization(address agent,address owner,address authenticator,uint256 nonce,uint64 deadline)"
    );
    bytes32 private constant _AUTHENTICATION_TYPEHASH = keccak256(
        "AgentAuthentication(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 private constant _REQUEST_TYPEHASH = keccak256(
        "AgentRequest(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash)"
    );
    bytes4 private constant _REQUEST_PROOF_PREFIX = 0x41575231; // "AWR1"
    bytes32 private constant _OWNER_ACTION_TYPEHASH = keccak256(
        "OwnerActionApproval(address agent,uint256 chainId,address target,uint256 value,bytes32 dataHash,bytes32 policyHash,uint256 policyRevision,uint256 nonce,uint64 deadline)"
    );
    bytes32 private constant _STATE_SLOT = keccak256("agentic.world.agent.account.storage.v1");

    address private immutable _implementationAddress;

    struct State {
        address owner;
        address authenticator;
        uint64 createdAt;
        bool initialized;
        bool authRevoked;
        uint256 bootstrapNonce;
        bytes policy;
        bytes32 policyHash;
        uint256 policyRevision;
        uint256 ownerApprovalNonce;
        bool executing;
    }

    /// @dev The signature argument to ERC-1271 is abi.encode(AuthProof).
    struct AuthProof {
        address agentId;
        bytes32 audienceHash;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes authenticatorSignature;
    }

    /// @dev ERC-1271 request signatures are 0x41575231 || abi.encode(RequestProof).
    struct RequestProof {
        address agentId;
        bytes32 audienceHash;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes32 methodHash;
        bytes32 targetHash;
        bytes32 bodyHash;
        bytes authenticatorSignature;
    }

    struct OwnerApproval {
        uint256 nonce;
        uint64 deadline;
        bytes signature;
    }

    error NotDelegated();
    error AlreadyInitialized();
    error NotInitialized();
    error NotOwner();
    error InvalidAuthenticator();
    error InvalidBootstrapNonce();
    error ExpiredAuthorization();
    error InvalidRootSignature();
    error AuthenticationIsRevoked();
    error AuthenticationNotRevoked();
    error NotAuthenticator();
    error PolicyDenied();
    error OwnerSignatureRequired();
    error InvalidOwnerSignature();
    error ApprovalExpired();
    error InvalidApprovalNonce();
    error ExecutionFailed();
    error ReentrantExecution();
    error TokenSpendExceeded();

    event AgentInitialized(address indexed agent, address indexed owner, address indexed authenticator);
    event AuthenticatorRotated(address indexed agent, address indexed authenticator);
    event AuthenticationRevoked(address indexed agent);
    event AuthenticationRestored(address indexed agent, address indexed authenticator);
    event PolicyUpdated(bytes32 indexed policyHash);
    event ActionExecuted(address indexed target, uint256 value, bytes4 selector, PolicyEngine.Decision decision);

    constructor() EIP712("Agentic World AgentAccount", "1") {
        _implementationAddress = address(this);
    }

    modifier onlyDelegated() {
        if (address(this) == _implementationAddress) revert NotDelegated();
        _;
    }

    modifier onlyOwner() {
        State storage state = _state();
        if (!state.initialized) revert NotInitialized();
        if (msg.sender != state.owner) revert NotOwner();
        _;
    }

    /// @notice The owner sends this transaction directly to 0xAGENT.
    /// @dev A root-signed permit binds msg.sender, preventing first-caller takeover.
    function initialize(
        address initialAuthenticator,
        uint256 nonce,
        uint64 deadline,
        bytes calldata rootSignature
    ) external onlyDelegated {
        State storage state = _state();
        if (state.initialized) revert AlreadyInitialized();
        _checkAuthenticator(initialAuthenticator, msg.sender);
        if (block.timestamp > deadline) revert ExpiredAuthorization();
        if (nonce != state.bootstrapNonce) revert InvalidBootstrapNonce();

        bytes32 structHash = keccak256(
            abi.encode(
                _INITIALIZATION_TYPEHASH,
                address(this),
                msg.sender,
                initialAuthenticator,
                nonce,
                deadline
            )
        );
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecoverCalldata(
            _hashTypedDataV4(structHash), rootSignature
        );
        if (error != ECDSA.RecoverError.NoError || recovered != address(this)) {
            revert InvalidRootSignature();
        }

        state.owner = msg.sender;
        state.authenticator = initialAuthenticator;
        state.createdAt = uint64(block.timestamp);
        state.initialized = true;
        state.bootstrapNonce = nonce + 1;

        emit AgentInitialized(address(this), msg.sender, initialAuthenticator);
    }

    function owner() external view onlyDelegated returns (address) {
        return _state().owner;
    }

    function authenticator() external view onlyDelegated returns (address) {
        return _state().authenticator;
    }

    function createdAt() external view onlyDelegated returns (uint64) {
        return _state().createdAt;
    }

    function authenticationRevoked() external view onlyDelegated returns (bool) {
        return _state().authRevoked;
    }

    function policy() external view onlyDelegated returns (bytes memory) {
        return _state().policy;
    }

    function policyHash() external view onlyDelegated returns (bytes32) {
        return _state().policyHash;
    }

    function policyRevision() external view onlyDelegated returns (uint256) {
        return _state().policyRevision;
    }

    function ownerApprovalNonce() external view onlyDelegated returns (uint256) {
        return _state().ownerApprovalNonce;
    }

    function protocolVersion() external pure returns (uint64) {
        return 1;
    }

    function rotateAuthenticator(address newAuthenticator) external onlyDelegated onlyOwner {
        State storage state = _state();
        if (state.authRevoked) revert AuthenticationIsRevoked();
        _checkAuthenticator(newAuthenticator, state.owner);
        state.authenticator = newAuthenticator;
        emit AuthenticatorRotated(address(this), newAuthenticator);
    }

    function revokeAuthenticator() external onlyDelegated onlyOwner {
        State storage state = _state();
        state.authRevoked = true;
        emit AuthenticationRevoked(address(this));
    }

    function restoreAuthenticator(address newAuthenticator) external onlyDelegated onlyOwner {
        State storage state = _state();
        if (!state.authRevoked) revert AuthenticationNotRevoked();
        _checkAuthenticator(newAuthenticator, state.owner);
        state.authenticator = newAuthenticator;
        state.authRevoked = false;
        emit AuthenticationRestored(address(this), newAuthenticator);
    }

    /// @notice The owner sets a versioned, canonical ABI policy at 0xAGENT.
    function setPolicy(bytes calldata newPolicy) external onlyDelegated onlyOwner {
        PolicyEngine.validate(newPolicy);
        State storage state = _state();
        state.policy = newPolicy;
        state.policyHash = keccak256(newPolicy);
        state.policyRevision += 1;
        emit PolicyUpdated(state.policyHash);
    }

    function evaluateAction(address target, uint256 value, bytes calldata data)
        external view onlyDelegated returns (PolicyEngine.Decision)
    {
        return PolicyEngine.evaluate(_state().policy, target, value, data);
    }

    /// @notice Only the current operating signer can request execution.
    /// @dev Native ETH value is spent from 0xAGENT's balance, not msg.value.
    function execute(address target, uint256 value, bytes calldata data, OwnerApproval calldata approval)
        external onlyDelegated returns (bytes memory result)
    {
        State storage state = _state();
        if (!state.initialized || state.authRevoked || msg.sender != state.authenticator) revert NotAuthenticator();
        if (state.executing) revert ReentrantExecution();
        state.executing = true;

        PolicyEngine.Decision decision = PolicyEngine.evaluate(state.policy, target, value, data);
        if (decision == PolicyEngine.Decision.DENY) revert PolicyDenied();
        if (decision == PolicyEngine.Decision.REQUIRE_OWNER_SIGNATURE) {
            if (approval.signature.length == 0) revert OwnerSignatureRequired();
            if (block.timestamp > approval.deadline) revert ApprovalExpired();
            if (approval.nonce != state.ownerApprovalNonce) revert InvalidApprovalNonce();
            bytes32 structHash = keccak256(abi.encode(
                _OWNER_ACTION_TYPEHASH,
                address(this),
                block.chainid,
                target,
                value,
                keccak256(data),
                state.policyHash,
                state.policyRevision,
                approval.nonce,
                approval.deadline
            ));
            if (!SignatureChecker.isValidSignatureNowCalldata(
                state.owner, _hashTypedDataV4(structHash), approval.signature
            )) revert InvalidOwnerSignature();
            state.ownerApprovalNonce = approval.nonce + 1;
        }

        (bool tokenPurchase, address token, uint256 declaredAmount) = PolicyEngine.tokenPurchaseDetails(data);
        uint256 tokenBalanceBefore = tokenPurchase ? IERC20(token).balanceOf(address(this)) : 0;
        (bool success, bytes memory returned) = target.call{value: value}(data);
        if (!success) revert ExecutionFailed();
        if (tokenPurchase) {
            uint256 tokenBalanceAfter = IERC20(token).balanceOf(address(this));
            if (tokenBalanceAfter < tokenBalanceBefore && tokenBalanceBefore - tokenBalanceAfter > declaredAmount) {
                revert TokenSpendExceeded();
            }
        }
        state.executing = false;
        emit ActionExecuted(target, value, data.length >= 4 ? bytes4(data[:4]) : bytes4(0), decision);
        return returned;
    }

    receive() external payable onlyDelegated {}

    /// @inheritdoc IERC1271
    /// @dev Only structured AgentAuthentication or AgentRequest proofs are recognized.
    ///      Arbitrary digests signed by the operating key are deliberately rejected.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (address(this) == _implementationAddress) return _INVALID_SIGNATURE;
        State storage state = _state();
        if (!state.initialized || state.authRevoked) return _INVALID_SIGNATURE;

        if (signature.length >= 4 && bytes4(signature[:4]) == _REQUEST_PROOF_PREFIX) {
            try this.decodeRequestProof(signature[4:]) returns (RequestProof memory proof) {
                if (proof.agentId != address(this) || proof.issuedAt > proof.expiresAt || block.timestamp > proof.expiresAt) {
                    return _INVALID_SIGNATURE;
                }
                bytes32 structHash = keccak256(abi.encode(
                    _REQUEST_TYPEHASH,
                    proof.agentId,
                    proof.audienceHash,
                    proof.nonce,
                    proof.issuedAt,
                    proof.expiresAt,
                    proof.methodHash,
                    proof.targetHash,
                    proof.bodyHash
                ));
                if (_hashTypedDataV4(structHash) != digest) return _INVALID_SIGNATURE;
                return _checkOperatingSignature(state.authenticator, digest, proof.authenticatorSignature);
            } catch {
                return _INVALID_SIGNATURE;
            }
        }

        try this.decodeAuthProof(signature) returns (AuthProof memory proof) {
            if (proof.agentId != address(this)) return _INVALID_SIGNATURE;
            if (proof.issuedAt > proof.expiresAt || block.timestamp > proof.expiresAt) {
                return _INVALID_SIGNATURE;
            }

            bytes32 structHash = keccak256(
                abi.encode(
                    _AUTHENTICATION_TYPEHASH,
                    proof.agentId,
                    proof.audienceHash,
                    proof.nonce,
                    proof.issuedAt,
                    proof.expiresAt
                )
            );
            if (_hashTypedDataV4(structHash) != digest) return _INVALID_SIGNATURE;

            return _checkOperatingSignature(state.authenticator, digest, proof.authenticatorSignature);
        } catch {
            return _INVALID_SIGNATURE;
        }
    }

    /// @dev External decoder lets ERC-1271 return an invalid magic value for
    ///      malformed ABI instead of reverting the service's eth_call.
    function decodeAuthProof(bytes calldata encoded) external pure returns (AuthProof memory) {
        return abi.decode(encoded, (AuthProof));
    }

    function decodeRequestProof(bytes calldata encoded) external pure returns (RequestProof memory) {
        return abi.decode(encoded, (RequestProof));
    }

    function _checkOperatingSignature(address signer, bytes32 digest, bytes memory signature)
        private pure returns (bytes4)
    {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        return error == ECDSA.RecoverError.NoError && recovered == signer ? _VALID_SIGNATURE : _INVALID_SIGNATURE;
    }

    function _checkAuthenticator(address signer, address accountOwner) private view {
        if (signer == address(0) || signer == address(this) || signer == accountOwner) {
            revert InvalidAuthenticator();
        }
    }

    function _state() private pure returns (State storage state) {
        bytes32 slot = _STATE_SLOT;
        assembly {
            state.slot := slot
        }
    }
}
