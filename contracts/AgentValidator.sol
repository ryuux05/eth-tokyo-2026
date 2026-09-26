// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC7579Validator, MODULE_TYPE_VALIDATOR, VALIDATION_FAILED, VALIDATION_SUCCESS} from
    "@openzeppelin/contracts/interfaces/draft-IERC7579.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @notice ERC-7579 validator for an agent account's KMS-held operating key.
/// @dev State is keyed by the calling account. It never accepts an owner key as an operating key.
contract AgentValidator is IERC7579Validator {
    bytes4 private constant _VALID = 0x1626ba7e;
    bytes4 private constant _INVALID = 0xffffffff;
    bytes4 private constant _REQUEST_PREFIX = 0x41575231; // AWR1
    bytes32 private constant _DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant _NAME_HASH = keccak256("Agentic World AgentAccount");
    bytes32 private constant _VERSION_HASH = keccak256("1");
    bytes32 private constant _AUTH_TYPEHASH = keccak256(
        "AgentAuthentication(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"
    );
    bytes32 private constant _REQUEST_TYPEHASH = keccak256(
        "AgentRequest(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash)"
    );

    struct AuthProof {
        address agentId;
        bytes32 audienceHash;
        bytes32 nonce;
        uint64 issuedAt;
        uint64 expiresAt;
        bytes authenticatorSignature;
    }

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

    struct KeyState {
        address authenticator;
        bytes32 qx;
        bytes32 qy;
        uint8 scheme; // 1 = secp256k1 prototype; 2 = P-256 local signer.
        bool installed;
        bool revoked;
    }

    mapping(address account => KeyState) private _keys;

    error AlreadyInstalled();
    error NotInstalled();
    error InvalidAuthenticator();
    error AuthenticationRevoked();
    error AuthenticationNotRevoked();

    event AuthenticatorRotated(address indexed account, address indexed authenticator);
    event P256AuthenticatorRotated(address indexed account, bytes32 qx, bytes32 qy);
    event AuthenticationRevokedFor(address indexed account);
    event AuthenticationRestoredFor(address indexed account, address indexed authenticator);

    function onInstall(bytes calldata data) external {
        if (_keys[msg.sender].installed) revert AlreadyInstalled();
        if (data.length == 32) {
            address signer = abi.decode(data, (address));
            _checkSigner(signer, msg.sender);
            _keys[msg.sender] = KeyState(signer, 0, 0, 1, true, false);
            emit AuthenticatorRotated(msg.sender, signer);
        } else {
            (uint8 scheme_, bytes32 qx, bytes32 qy) = abi.decode(data, (uint8, bytes32, bytes32));
            if (scheme_ != 2 || !P256.isValidPublicKey(qx, qy)) revert InvalidAuthenticator();
            _keys[msg.sender] = KeyState(address(0), qx, qy, 2, true, false);
            emit P256AuthenticatorRotated(msg.sender, qx, qy);
        }
    }

    function onUninstall(bytes calldata) external pure {
        revert NotInstalled(); // v0 account fixes this module in place.
    }

    function isModuleType(uint256 moduleTypeId) external pure returns (bool) {
        return moduleTypeId == MODULE_TYPE_VALIDATOR;
    }

    function authenticator(address account) external view returns (address) {
        return _keys[account].authenticator;
    }

    function authenticatorScheme(address account) external view returns (uint8) {
        return _keys[account].scheme;
    }

    function authenticatorP256(address account) external view returns (bytes32 qx, bytes32 qy) {
        KeyState storage key = _keys[account];
        return (key.qx, key.qy);
    }

    function authenticationRevoked(address account) external view returns (bool) {
        return _keys[account].revoked;
    }

    /// @dev The account calls this only after its direct human-owner check.
    function rotateAuthenticator(address newAuthenticator) external {
        KeyState storage key = _installedKey(msg.sender);
        if (key.revoked) revert AuthenticationRevoked();
        _checkSigner(newAuthenticator, msg.sender);
        key.authenticator = newAuthenticator;
        key.qx = 0;
        key.qy = 0;
        key.scheme = 1;
        emit AuthenticatorRotated(msg.sender, newAuthenticator);
    }

    function rotateP256Authenticator(bytes32 qx, bytes32 qy) external {
        KeyState storage key = _installedKey(msg.sender);
        if (key.revoked) revert AuthenticationRevoked();
        _setP256(key, qx, qy);
        emit P256AuthenticatorRotated(msg.sender, qx, qy);
    }

    function revokeAuthenticator() external {
        KeyState storage key = _installedKey(msg.sender);
        key.revoked = true;
        emit AuthenticationRevokedFor(msg.sender);
    }

    function restoreAuthenticator(address newAuthenticator) external {
        KeyState storage key = _installedKey(msg.sender);
        if (!key.revoked) revert AuthenticationNotRevoked();
        _checkSigner(newAuthenticator, msg.sender);
        key.authenticator = newAuthenticator;
        key.qx = 0;
        key.qy = 0;
        key.scheme = 1;
        key.revoked = false;
        emit AuthenticationRestoredFor(msg.sender, newAuthenticator);
    }

    function restoreP256Authenticator(bytes32 qx, bytes32 qy) external {
        KeyState storage key = _installedKey(msg.sender);
        if (!key.revoked) revert AuthenticationNotRevoked();
        _setP256(key, qx, qy);
        key.revoked = false;
        emit AuthenticationRestoredFor(msg.sender, address(0));
        emit P256AuthenticatorRotated(msg.sender, qx, qy);
    }

    function validateUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash) external view returns (uint256) {
        KeyState storage key = _keys[msg.sender];
        if (!key.installed || key.revoked || userOp.sender != msg.sender) return VALIDATION_FAILED;
        return _signedBy(key, userOpHash, userOp.signature) ? VALIDATION_SUCCESS : VALIDATION_FAILED;
    }

    function isValidSignatureWithSender(address, bytes32 hash, bytes calldata signature)
        external view returns (bytes4)
    {
        KeyState storage key = _keys[msg.sender];
        if (!key.installed || key.revoked) return _INVALID;
        if (signature.length >= 4 && bytes4(signature[:4]) == _REQUEST_PREFIX) {
            try this.decodeRequestProof(signature[4:]) returns (RequestProof memory proof) {
                if (proof.agentId != msg.sender || proof.issuedAt > proof.expiresAt || block.timestamp > proof.expiresAt) {
                    return _INVALID;
                }
                bytes32 structHash = keccak256(abi.encode(
                    _REQUEST_TYPEHASH, proof.agentId, proof.audienceHash, proof.nonce, proof.issuedAt,
                    proof.expiresAt, proof.methodHash, proof.targetHash, proof.bodyHash
                ));
                return _typedHash(msg.sender, structHash) == hash &&
                    _signedBy(key, hash, proof.authenticatorSignature) ? _VALID : _INVALID;
            } catch { return _INVALID; }
        }
        try this.decodeAuthProof(signature) returns (AuthProof memory proof) {
            if (proof.agentId != msg.sender || proof.issuedAt > proof.expiresAt || block.timestamp > proof.expiresAt) {
                return _INVALID;
            }
            bytes32 structHash = keccak256(abi.encode(
                _AUTH_TYPEHASH, proof.agentId, proof.audienceHash, proof.nonce, proof.issuedAt, proof.expiresAt
            ));
            return _typedHash(msg.sender, structHash) == hash &&
                _signedBy(key, hash, proof.authenticatorSignature) ? _VALID : _INVALID;
        } catch { return _INVALID; }
    }

    function decodeRequestProof(bytes calldata data) external pure returns (RequestProof memory) {
        return abi.decode(data, (RequestProof));
    }

    function decodeAuthProof(bytes calldata data) external pure returns (AuthProof memory) {
        return abi.decode(data, (AuthProof));
    }

    function _installedKey(address account) private view returns (KeyState storage key) {
        key = _keys[account];
        if (!key.installed) revert NotInstalled();
    }

    function _checkSigner(address signer, address account) private pure {
        if (signer == address(0) || signer == account) revert InvalidAuthenticator();
    }

    function _setP256(KeyState storage key, bytes32 qx, bytes32 qy) private {
        if (!P256.isValidPublicKey(qx, qy)) revert InvalidAuthenticator();
        key.authenticator = address(0);
        key.qx = qx;
        key.qy = qy;
        key.scheme = 2;
    }

    function _signedBy(KeyState storage key, bytes32 digest, bytes memory signature) private view returns (bool) {
        if (key.scheme == 2) {
            if (signature.length != 64) return false;
            bytes32 r;
            bytes32 s;
            assembly ("memory-safe") {
                r := mload(add(signature, 0x20))
                s := mload(add(signature, 0x40))
            }
            // EIP-7951 at 0x100. Fail closed on chains without the precompile.
            return P256.verifyNative(digest, r, s, key.qx, key.qy);
        }
        if (key.scheme != 1) return false;
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        return error == ECDSA.RecoverError.NoError && recovered == key.authenticator;
    }

    function _typedHash(address account, bytes32 structHash) private view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(_DOMAIN_TYPEHASH, _NAME_HASH, _VERSION_HASH, block.chainid, account));
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }
}
