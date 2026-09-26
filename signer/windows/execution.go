package main

import (
	"bytes"
	"encoding/hex"
	"errors"
	"math/big"
	"strings"
	"time"
)

type executionOperation struct{ Sender, Nonce, CallData, AccountGasLimits, PreVerificationGas, GasFees string }
type executionRequest struct {
	Kind, Label, EntryPoint string
	ChainID, ValidUntil     uint64
	UserOperation           executionOperation
}

func executionHex(value string, size int) ([]byte, error) {
	result, err := hex.DecodeString(strings.TrimPrefix(value, "0x"))
	if err != nil || (size >= 0 && len(result) != size) {
		return nil, errors.New("invalid execution hex")
	}
	return result, nil
}
func executionDigest(input executionRequest) ([]byte, error) {
	invalid := errors.New("invalid execution request, transfer, expiry or gas budget")
	now := uint64(time.Now().Unix())
	if input.Kind != "AgentExecution" || (input.ChainID != 11155111 && input.ChainID != 31337) || input.ValidUntil <= now || input.ValidUntil > now+300 {
		return nil, invalid
	}
	if input.ChainID == 11155111 && strings.ToLower(input.EntryPoint) != "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" {
		return nil, invalid
	}
	op := input.UserOperation
	sender, err := executionHex(op.Sender, 20)
	if err != nil {
		return nil, err
	}
	ep, err := executionHex(input.EntryPoint, 20)
	if err != nil {
		return nil, err
	}
	if new(big.Int).SetBytes(sender).Sign() == 0 || new(big.Int).SetBytes(ep).Sign() == 0 {
		return nil, invalid
	}
	data, err := executionHex(op.CallData, -1)
	if err != nil {
		return nil, err
	}
	if len(data) < 228 || len(data) > 4096 {
		return nil, invalid
	}
	approved := hex.EncodeToString(data[:4]) == "adc3d7cb"
	if (!approved && hex.EncodeToString(data[:4]) != "e9ae5c53") || new(big.Int).SetBytes(data[4:36]).Sign() != 0 {
		return nil, invalid
	}
	offset := int64(64)
	if approved {
		offset = 160
	}
	if new(big.Int).SetBytes(data[36:68]).Cmp(big.NewInt(offset)) != 0 {
		return nil, invalid
	}
	start := 4 + int(offset)
	if len(data) < start+160 || new(big.Int).SetBytes(data[start:start+32]).Cmp(big.NewInt(120)) != 0 {
		return nil, invalid
	}
	p := start + 32
	if new(big.Int).SetBytes(data[p+20:p+52]).Sign() != 0 || hex.EncodeToString(data[p+52:p+56]) != "a9059cbb" || new(big.Int).SetBytes(data[p+56:p+68]).Sign() != 0 ||
		new(big.Int).SetBytes(data[p+68:p+88]).Sign() == 0 || bytes.Equal(sender, data[p+68:p+88]) || new(big.Int).SetBytes(data[p+88:p+120]).Sign() == 0 {
		return nil, invalid
	}
	if input.ChainID == 11155111 && hex.EncodeToString(data[p:p+20]) != "1c7d4b196cb0c7b01d743fbc6116a902379c7238" {
		return nil, invalid
	}
	if approved {
		if len(data) < 356 || new(big.Int).SetBytes(data[132:164]).Cmp(big.NewInt(320)) != 0 {
			return nil, invalid
		}
		size := new(big.Int).SetBytes(data[324:356])
		if !size.IsInt64() || size.Sign() <= 0 || size.Int64() > 2048 || len(data) != 356+((int(size.Int64())+31)/32)*32 || new(big.Int).SetBytes(data[100:132]).Cmp(new(big.Int).SetUint64(input.ValidUntil)) < 0 {
			return nil, invalid
		}
	} else if len(data) != 228 {
		return nil, invalid
	}
	nonce, err := executionHex(op.Nonce, 32)
	if err != nil {
		return nil, err
	}
	gas, err := executionHex(op.AccountGasLimits, 32)
	if err != nil {
		return nil, err
	}
	fees, err := executionHex(op.GasFees, 32)
	if err != nil {
		return nil, err
	}
	pre, err := executionHex(op.PreVerificationGas, 32)
	if err != nil {
		return nil, err
	}
	verification := new(big.Int).SetBytes(gas[:16])
	call := new(big.Int).SetBytes(gas[16:])
	overhead := new(big.Int).SetBytes(pre)
	priority := new(big.Int).SetBytes(fees[:16])
	maxFee := new(big.Int).SetBytes(fees[16:])
	units := new(big.Int).Add(verification, call)
	units.Add(units, overhead)
	if verification.Sign() <= 0 || call.Sign() <= 0 || units.Cmp(big.NewInt(5000000)) > 0 || priority.Cmp(maxFee) > 0 || maxFee.Cmp(big.NewInt(100000000000)) > 0 || new(big.Int).Mul(units, maxFee).Cmp(big.NewInt(5000000000000000)) > 0 {
		return nil, invalid
	}
	hashString := func(s string) []byte { return keccak([]byte(s)) }
	padded := func(b []byte) []byte { return append(make([]byte, 12), b...) }
	concat := func(parts ...[]byte) []byte {
		var r []byte
		for _, part := range parts {
			r = append(r, part...)
		}
		return r
	}
	domainType := hashString("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
	epDomain := keccak(concat(domainType, hashString("ERC4337"), hashString("1"), word(input.ChainID), padded(ep)))
	packed := keccak(concat(hashString("PackedUserOperation(address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData)"), padded(sender), nonce, keccak(nil), keccak(data), gas, pre, fees, keccak(nil)))
	userOpHash := keccak(concat([]byte{0x19, 0x01}, epDomain, packed))
	domain := keccak(concat(domainType, hashString("Agentic World AgentAccount"), hashString("1"), word(input.ChainID), padded(sender)))
	action := keccak(concat(hashString("AgentExecution(bytes32 userOpHash,uint48 validUntil)"), userOpHash, word(input.ValidUntil)))
	return keccak(concat([]byte{0x19, 0x01}, domain, action)), nil
}
