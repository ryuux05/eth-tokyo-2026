//go:build !windows

package main

import "errors"

func platformAvailability() bool { return false }
func platformProvision(string) ([]byte, []byte, error) {
	return nil, nil, errors.New("TPM signing requires Windows")
}
func platformPublicKey(string) ([]byte, []byte, error) {
	return nil, nil, errors.New("TPM signing requires Windows")
}
func platformSign(string, []byte) ([]byte, error) {
	return nil, errors.New("TPM signing requires Windows")
}
