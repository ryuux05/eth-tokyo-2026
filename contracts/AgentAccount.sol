// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

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
    bytes32 private constant _STATE_SLOT = keccak256("agentic.world.agent.account.storage.v1");

    address private immutable _implementationAddress;

    struct State {
        address owner;
        address authenticator;
        uint64 createdAt;
        bool initialized;
        bool authRevoked;
        uint256 bootstrapNonce;
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

    event AgentInitialized(address indexed agent, address indexed owner, address indexed authenticator);
    event AuthenticatorRotated(address indexed agent, address indexed authenticator);
    event AuthenticationRevoked(address indexed agent);
    event AuthenticationRestored(address indexed agent, address indexed authenticator);

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

    /// @inheritdoc IERC1271
    /// @dev Only an EIP-712 AgentAuthentication proof is recognized. Arbitrary
    ///      digests signed by the operating key are deliberately rejected.
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        if (address(this) == _implementationAddress) return _INVALID_SIGNATURE;
        State storage state = _state();
        if (!state.initialized || state.authRevoked) return _INVALID_SIGNATURE;

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

            (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(
                digest, proof.authenticatorSignature
            );
            if (error != ECDSA.RecoverError.NoError || recovered != state.authenticator) {
                return _INVALID_SIGNATURE;
            }
            return _VALID_SIGNATURE;
        } catch {
            return _INVALID_SIGNATURE;
        }
    }

    /// @dev External decoder lets ERC-1271 return an invalid magic value for
    ///      malformed ABI instead of reverting the service's eth_call.
    function decodeAuthProof(bytes calldata encoded) external pure returns (AuthProof memory) {
        return abi.decode(encoded, (AuthProof));
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
