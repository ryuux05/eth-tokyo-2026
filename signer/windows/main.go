package main

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net/url"
	"os"
	"strings"
	"time"
	"unicode"
)

// The TPM helper receives protocol objects, never an arbitrary digest from MCP.
// Keep these EIP-712 definitions and validation rules aligned with AgenticSigner.swift.
type request struct {
	Kind, Label, AgentID, Audience, Method, Target, BodyBase64 string
	ChainID                                                    uint64
}

type challenge struct {
	AgentID, Audience, Nonce     string
	ChainID, IssuedAt, ExpiresAt uint64
}

type challengeRequest struct {
	Kind, Label string
	Challenge   challenge
}

var rotations = [25]uint{0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14}
var roundConstants = [24]uint64{
	0x0000000000000001, 0x0000000000008082, 0x800000000000808a, 0x8000000080008000,
	0x000000000000808b, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
	0x000000000000008a, 0x0000000000000088, 0x0000000080008009, 0x000000008000000a,
	0x000000008000808b, 0x800000000000008b, 0x8000000000008089, 0x8000000000008003,
	0x8000000000008002, 0x8000000000000080, 0x000000000000800a, 0x800000008000000a,
	0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
}

func rotate(v uint64, n uint) uint64 {
	if n == 0 {
		return v
	}
	return v<<n | v>>(64-n)
}

func keccak(input []byte) []byte {
	message := append(append([]byte{}, input...), 0x01)
	for len(message)%136 != 135 {
		message = append(message, 0)
	}
	message = append(message, 0x80)
	var state [25]uint64
	for start := 0; start < len(message); start += 136 {
		for i := 0; i < 136; i++ {
			state[i/8] ^= uint64(message[start+i]) << (8 * uint(i%8))
		}
		for _, constant := range roundConstants {
			var c [5]uint64
			for x := 0; x < 5; x++ {
				for y := 0; y < 5; y++ {
					c[x] ^= state[x+5*y]
				}
			}
			for x := 0; x < 5; x++ {
				d := c[(x+4)%5] ^ rotate(c[(x+1)%5], 1)
				for y := 0; y < 5; y++ {
					state[x+5*y] ^= d
				}
			}
			var b [25]uint64
			for x := 0; x < 5; x++ {
				for y := 0; y < 5; y++ {
					i := x + 5*y
					b[y+5*((2*x+3*y)%5)] = rotate(state[i], rotations[i])
				}
			}
			for x := 0; x < 5; x++ {
				for y := 0; y < 5; y++ {
					state[x+5*y] = b[x+5*y] ^ (^b[(x+1)%5+5*y] & b[(x+2)%5+5*y])
				}
			}
			state[0] ^= constant
		}
	}
	out := make([]byte, 32)
	for i := range out {
		out[i] = byte(state[i/8] >> (8 * uint(i%8)))
	}
	return out
}

func hashString(v string) []byte { return keccak([]byte(v)) }
func word(v uint64) []byte {
	out := make([]byte, 32)
	binary.BigEndian.PutUint64(out[24:], v)
	return out
}
func concat(parts ...[]byte) []byte {
	var out []byte
	for _, part := range parts {
		out = append(out, part...)
	}
	return out
}
func hexBytes(v []byte) string { return "0x" + hex.EncodeToString(v) }
func parseHex(v string, length int) ([]byte, error) {
	if !strings.HasPrefix(v, "0x") || len(v) != 2+length*2 {
		return nil, errors.New("invalid hexadecimal length")
	}
	decoded, err := hex.DecodeString(v[2:])
	if err != nil {
		return nil, errors.New("invalid hexadecimal value")
	}
	return decoded, nil
}
func paddedAgent(v string) ([]byte, error) {
	agent, err := parseHex(v, 20)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(agent, make([]byte, 20)) {
		return nil, errors.New("zero agent ID")
	}
	return append(make([]byte, 12), agent...), nil
}
func validateAudience(value string) error {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Opaque != "" ||
		u.Path != "" || u.RawQuery != "" || u.Fragment != "" || u.RawFragment != "" ||
		value != "https://"+u.Host || u.Host != strings.ToLower(u.Host) {
		return errors.New("audience must be a canonical HTTPS origin")
	}
	return nil
}

func domain(chainID uint64, agent []byte) []byte {
	return keccak(concat(hashString("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
		hashString("Agentic World AgentAccount"), hashString("1"), word(chainID), agent))
}
func typedDigest(domainHash, structHash []byte) []byte {
	return keccak(concat([]byte{0x19, 0x01}, domainHash, structHash))
}

func challengeDigest(c challenge, enforceTime bool) ([]byte, error) {
	if c.ChainID == 0 {
		return nil, errors.New("invalid chain ID")
	}
	if err := validateAudience(c.Audience); err != nil {
		return nil, err
	}
	now := uint64(time.Now().Unix())
	if enforceTime && (c.IssuedAt > now+30 || c.ExpiresAt <= now || c.ExpiresAt <= c.IssuedAt || c.ExpiresAt-c.IssuedAt > 300) {
		return nil, errors.New("challenge is expired or outside the accepted time window")
	}
	agent, err := paddedAgent(c.AgentID)
	if err != nil {
		return nil, err
	}
	nonce, err := parseHex(c.Nonce, 32)
	if err != nil {
		return nil, err
	}
	structure := keccak(concat(hashString("AgentAuthentication(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt)"),
		agent, hashString(c.Audience), nonce, word(c.IssuedAt), word(c.ExpiresAt)))
	return typedDigest(domain(c.ChainID, agent), structure), nil
}

func requestDigest(r request, nonce []byte, issuedAt, expiresAt uint64) ([]byte, []byte, error) {
	if r.ChainID == 0 {
		return nil, nil, errors.New("invalid chain ID")
	}
	if err := validateAudience(r.Audience); err != nil {
		return nil, nil, err
	}
	switch r.Method {
	case "GET", "POST", "PUT", "PATCH", "DELETE":
	default:
		return nil, nil, errors.New("unsupported method")
	}
	if !strings.HasPrefix(r.Target, "/") || strings.HasPrefix(r.Target, "//") || strings.ContainsAny(r.Target, "#\\") ||
		strings.IndexFunc(r.Target, unicode.IsSpace) >= 0 {
		return nil, nil, errors.New("invalid origin-form target")
	}
	body, err := base64.StdEncoding.Strict().DecodeString(r.BodyBase64)
	if err != nil || len(body) > 65_536 {
		return nil, nil, errors.New("invalid or oversized body")
	}
	if r.Method == "GET" && len(body) != 0 {
		return nil, nil, errors.New("GET cannot have a body")
	}
	agent, err := paddedAgent(r.AgentID)
	if err != nil {
		return nil, nil, err
	}
	bodyHash := keccak(body)
	structure := keccak(concat(hashString("AgentRequest(address agentId,bytes32 audienceHash,bytes32 nonce,uint64 issuedAt,uint64 expiresAt,bytes32 methodHash,bytes32 targetHash,bytes32 bodyHash)"),
		agent, hashString(r.Audience), nonce, word(issuedAt), word(expiresAt), hashString(r.Method), hashString(r.Target), bodyHash))
	return typedDigest(domain(r.ChainID, agent), structure), bodyHash, nil
}

var order, _ = new(big.Int).SetString("ffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551", 16)

func lowS(signature []byte) ([]byte, error) {
	if len(signature) != 64 {
		return nil, errors.New("invalid P-256 signature length")
	}
	r := new(big.Int).SetBytes(signature[:32])
	s := new(big.Int).SetBytes(signature[32:])
	if r.Sign() <= 0 || r.Cmp(order) >= 0 || s.Sign() <= 0 || s.Cmp(order) >= 0 {
		return nil, errors.New("invalid P-256 signature scalar")
	}
	if s.Cmp(new(big.Int).Rsh(new(big.Int).Set(order), 1)) > 0 {
		s = new(big.Int).Sub(order, s)
		out := append([]byte{}, signature...)
		copy(out[32:], s.FillBytes(make([]byte, 32)))
		return out, nil
	}
	return signature, nil
}

func readJSON(limit int64, target any) error {
	input, err := io.ReadAll(io.LimitReader(os.Stdin, limit+1))
	if err != nil || int64(len(input)) > limit {
		return errors.New("signing input too large")
	}
	if err := json.Unmarshal(input, target); err != nil {
		return errors.New("invalid signing input")
	}
	return nil
}
func output(value any) error { return json.NewEncoder(os.Stdout).Encode(value) }

func run(args []string) error {
	if len(args) == 1 && args[0] == "self-test" {
		r := request{Kind: "AgentRequest", Label: "test", AgentID: "0x" + strings.Repeat("11", 20), ChainID: 31337,
			Audience: "https://service-a.example", Method: "POST", Target: "/report?format=json", BodyBase64: base64.StdEncoding.EncodeToString([]byte(`{"ok":true}`))}
		hash, bodyHash, err := requestDigest(r, bytes.Repeat([]byte{0x22}, 32), 1_700_000_000, 1_700_000_060)
		if err != nil || hexBytes(hash) != "0xa3a2724afd21df5edf29f4edcff382d9ea174b87a8c505584b5f12ab141e1e3d" ||
			hexBytes(bodyHash) != "0xaf7220891333e24ced1fcd91362b60dd07458c77d6658c92e4306e08eb7a8317" {
			return errors.New("EIP-712 request self-test failed")
		}
		c := challenge{AgentID: r.AgentID, Audience: r.Audience, ChainID: r.ChainID, Nonce: "0x" + strings.Repeat("22", 32), IssuedAt: 1_700_000_000, ExpiresAt: 1_700_000_060}
		challengeHash, err := challengeDigest(c, false)
		if err != nil || hexBytes(challengeHash) != "0xcc0a62bbb07f2774ff53282919ef91ec302742394a18a42d0fb7cfacb6341e65" {
			return errors.New("EIP-712 challenge self-test failed")
		}
		return output(map[string]any{"ok": true, "requestDigest": hexBytes(hash), "challengeDigest": hexBytes(challengeHash)})
	}
	if len(args) == 1 && args[0] == "availability" {
		return output(map[string]any{"tpmAvailable": platformAvailability()})
	}
	if len(args) == 2 && args[0] == "hash" {
		input, err := hex.DecodeString(strings.TrimPrefix(args[1], "0x"))
		if err != nil {
			return err
		}
		return output(map[string]any{"hash": hexBytes(keccak(input))})
	}
	if len(args) != 2 || len(args[1]) < 1 || len(args[1]) > 128 {
		return errors.New("expected provision, public-key, sign-challenge, or sign-request with a key label")
	}
	command, label := args[0], args[1]
	if command == "provision" {
		qx, qy, err := platformProvision(label)
		if err != nil {
			return err
		}
		return output(map[string]any{"scheme": "p256", "qx": hexBytes(qx), "qy": hexBytes(qy)})
	}
	if command == "public-key" {
		qx, qy, err := platformPublicKey(label)
		if err != nil {
			return err
		}
		return output(map[string]any{"scheme": "p256", "qx": hexBytes(qx), "qy": hexBytes(qy)})
	}
	if command == "sign-challenge" {
		var input challengeRequest
		if err := readJSON(4096, &input); err != nil {
			return err
		}
		if input.Kind != "AgentAuthentication" || input.Label != label {
			return errors.New("unsupported signing type or key label mismatch")
		}
		hash, err := challengeDigest(input.Challenge, true)
		if err != nil {
			return err
		}
		signature, err := platformSign(label, hash)
		if err != nil {
			return err
		}
		signature, err = lowS(signature)
		if err != nil {
			return err
		}
		c := input.Challenge
		return output(map[string]any{"agentId": c.AgentID, "audience": c.Audience, "chainId": c.ChainID,
			"nonce": c.Nonce, "issuedAt": c.IssuedAt, "expiresAt": c.ExpiresAt, "signature": hexBytes(signature)})
	}
	if command == "sign-request" {
		var input request
		if err := readJSON(100_000, &input); err != nil {
			return err
		}
		if input.Kind != "AgentRequest" || input.Label != label {
			return errors.New("unsupported signing type or key label mismatch")
		}
		nonce := make([]byte, 32)
		if _, err := rand.Read(nonce); err != nil {
			return err
		}
		issuedAt := uint64(time.Now().Unix())
		expiresAt := issuedAt + 60
		hash, bodyHash, err := requestDigest(input, nonce, issuedAt, expiresAt)
		if err != nil {
			return err
		}
		signature, err := platformSign(label, hash)
		if err != nil {
			return err
		}
		signature, err = lowS(signature)
		if err != nil {
			return err
		}
		return output(map[string]any{"agentId": input.AgentID, "audience": input.Audience, "chainId": input.ChainID,
			"nonce": hexBytes(nonce), "issuedAt": issuedAt, "expiresAt": expiresAt, "method": input.Method,
			"target": input.Target, "bodyHash": hexBytes(bodyHash), "signature": hexBytes(signature)})
	}
	return errors.New("unsupported command")
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, "Agentic signer:", err)
		os.Exit(1)
	}
}
