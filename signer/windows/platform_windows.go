//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

// The Platform Crypto Provider binds a non-exportable key to the local TPM.
// No software-provider fallback is allowed: absence of TPM/P-256 fails closed.
var ncrypt = syscall.NewLazyDLL("ncrypt.dll")
var openProvider = ncrypt.NewProc("NCryptOpenStorageProvider")
var isAlgorithmSupported = ncrypt.NewProc("NCryptIsAlgSupported")
var openKey = ncrypt.NewProc("NCryptOpenKey")
var createKey = ncrypt.NewProc("NCryptCreatePersistedKey")
var setProperty = ncrypt.NewProc("NCryptSetProperty")
var getProperty = ncrypt.NewProc("NCryptGetProperty")
var finalizeKey = ncrypt.NewProc("NCryptFinalizeKey")
var exportKey = ncrypt.NewProc("NCryptExportKey")
var signHash = ncrypt.NewProc("NCryptSignHash")
var freeObject = ncrypt.NewProc("NCryptFreeObject")

func checked(name string, status uintptr) error {
	if uint32(status) != 0 {
		return fmt.Errorf("%s failed (0x%08x)", name, uint32(status))
	}
	return nil
}
func wide(value string) *uint16 { return syscall.StringToUTF16Ptr(value) }
func pointer(value []byte) unsafe.Pointer {
	if len(value) == 0 {
		return nil
	}
	return unsafe.Pointer(&value[0])
}
func closeHandle(handle uintptr) {
	if handle != 0 {
		freeObject.Call(handle)
	}
}
func provider() (uintptr, error) {
	var handle uintptr
	status, _, _ := openProvider.Call(uintptr(unsafe.Pointer(&handle)), uintptr(unsafe.Pointer(wide("Microsoft Platform Crypto Provider"))), 0)
	if err := checked("NCryptOpenStorageProvider", status); err != nil {
		return 0, err
	}
	return handle, nil
}
func supported(handle uintptr) bool {
	status, _, _ := isAlgorithmSupported.Call(handle, uintptr(unsafe.Pointer(wide("ECDSA_P256"))), 0)
	return uint32(status) == 0
}
func platformAvailability() bool {
	handle, err := provider()
	if err != nil {
		return false
	}
	defer closeHandle(handle)
	return supported(handle)
}
func keyName(label string) string {
	sum := sha256.Sum256([]byte(label))
	return "agentic-world-" + hex.EncodeToString(sum[:])
}
func loadKey(providerHandle uintptr, label string) (uintptr, error) {
	var key uintptr
	status, _, _ := openKey.Call(providerHandle, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(wide(keyName(label)))), 0, 0)
	if err := checked("NCryptOpenKey", status); err != nil {
		return 0, err
	}
	if err := checkNonExportable(key); err != nil {
		closeHandle(key)
		return 0, err
	}
	return key, nil
}
func checkNonExportable(key uintptr) error {
	var policy, size uint32
	status, _, _ := getProperty.Call(key, uintptr(unsafe.Pointer(wide("Export Policy"))), uintptr(unsafe.Pointer(&policy)), 4, uintptr(unsafe.Pointer(&size)), 0)
	if err := checked("NCryptGetProperty", status); err != nil {
		return err
	}
	if size != 4 || policy != 0 {
		return errors.New("TPM key export policy is not disabled")
	}
	return nil
}
func publicCoordinates(key uintptr) ([]byte, []byte, error) {
	var size uint32
	status, _, _ := exportKey.Call(key, 0, uintptr(unsafe.Pointer(wide("ECCPUBLICBLOB"))), 0, 0, 0, uintptr(unsafe.Pointer(&size)), 0)
	if err := checked("NCryptExportKey", status); err != nil {
		return nil, nil, err
	}
	if size != 72 {
		return nil, nil, errors.New("unexpected P-256 public key size")
	}
	buffer := make([]byte, size)
	status, _, _ = exportKey.Call(key, 0, uintptr(unsafe.Pointer(wide("ECCPUBLICBLOB"))), 0, uintptr(pointer(buffer)), uintptr(len(buffer)), uintptr(unsafe.Pointer(&size)), 0)
	if err := checked("NCryptExportKey", status); err != nil {
		return nil, nil, err
	}
	if size != 72 || binary.LittleEndian.Uint32(buffer[:4]) != 0x31534345 || binary.LittleEndian.Uint32(buffer[4:8]) != 32 {
		return nil, nil, errors.New("TPM key is not ECDSA P-256")
	}
	return buffer[8:40], buffer[40:72], nil
}
func platformProvision(label string) ([]byte, []byte, error) {
	handle, err := provider()
	if err != nil {
		return nil, nil, err
	}
	defer closeHandle(handle)
	if !supported(handle) {
		return nil, nil, errors.New("TPM does not support ECDSA P-256")
	}
	// No overwrite flag. A label already in use must never silently change identity.
	var key uintptr
	status, _, _ := createKey.Call(handle, uintptr(unsafe.Pointer(&key)), uintptr(unsafe.Pointer(wide("ECDSA_P256"))), uintptr(unsafe.Pointer(wide(keyName(label)))), 0, 0)
	if err := checked("NCryptCreatePersistedKey", status); err != nil {
		return nil, nil, err
	}
	defer closeHandle(key)
	var noExport uint32
	status, _, _ = setProperty.Call(key, uintptr(unsafe.Pointer(wide("Export Policy"))), uintptr(unsafe.Pointer(&noExport)), 4, 0)
	if err := checked("NCryptSetProperty", status); err != nil {
		return nil, nil, err
	}
	status, _, _ = finalizeKey.Call(key, 0)
	if err := checked("NCryptFinalizeKey", status); err != nil {
		return nil, nil, err
	}
	if err := checkNonExportable(key); err != nil {
		return nil, nil, err
	}
	return publicCoordinates(key)
}
func platformPublicKey(label string) ([]byte, []byte, error) {
	handle, err := provider()
	if err != nil {
		return nil, nil, err
	}
	defer closeHandle(handle)
	key, err := loadKey(handle, label)
	if err != nil {
		return nil, nil, err
	}
	defer closeHandle(key)
	return publicCoordinates(key)
}
func platformSign(label string, hash []byte) ([]byte, error) {
	if len(hash) != 32 {
		return nil, errors.New("invalid EIP-712 digest length")
	}
	handle, err := provider()
	if err != nil {
		return nil, err
	}
	defer closeHandle(handle)
	key, err := loadKey(handle, label)
	if err != nil {
		return nil, err
	}
	defer closeHandle(key)
	if _, _, err := publicCoordinates(key); err != nil {
		return nil, err
	}
	signature := make([]byte, 64)
	var size uint32
	status, _, _ := signHash.Call(key, 0, uintptr(pointer(hash)), uintptr(len(hash)), uintptr(pointer(signature)), uintptr(len(signature)), uintptr(unsafe.Pointer(&size)), 0)
	if err := checked("NCryptSignHash", status); err != nil {
		return nil, err
	}
	if size != 64 {
		return nil, errors.New("unexpected P-256 signature size")
	}
	return signature, nil
}
