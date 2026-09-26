package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"strings"
	"testing"
	"time"
)

func TestMCPWireFields(t *testing.T) {
	var input challengeRequest
	if err := json.Unmarshal([]byte(`{"kind":"AgentAuthentication","label":"test","challenge":{"agentId":"0x1111111111111111111111111111111111111111","chainId":31337,"audience":"https://service-a.example","nonce":"0x2222222222222222222222222222222222222222222222222222222222222222","issuedAt":1700000000,"expiresAt":1700000060}}`), &input); err != nil {
		t.Fatal(err)
	}
	if input.Challenge.AgentID != "0x1111111111111111111111111111111111111111" || input.Challenge.ChainID != 31337 {
		t.Fatalf("MCP field mapping failed: %#v", input.Challenge)
	}
}

func TestEIP712Vectors(t *testing.T) {
	r := request{Kind: "AgentRequest", Label: "test", AgentID: "0x" + strings.Repeat("11", 20), ChainID: 31337,
		Audience: "https://service-a.example", Method: "POST", Target: "/report?format=json", BodyBase64: base64.StdEncoding.EncodeToString([]byte(`{"ok":true}`))}
	hash, bodyHash, err := requestDigest(r, bytes.Repeat([]byte{0x22}, 32), 1_700_000_000, 1_700_000_060)
	if err != nil {
		t.Fatal(err)
	}
	if got := hexBytes(hash); got != "0xa3a2724afd21df5edf29f4edcff382d9ea174b87a8c505584b5f12ab141e1e3d" {
		t.Fatalf("request digest: %s", got)
	}
	if got := hexBytes(bodyHash); got != "0xaf7220891333e24ced1fcd91362b60dd07458c77d6658c92e4306e08eb7a8317" {
		t.Fatalf("body digest: %s", got)
	}
	c := challenge{AgentID: r.AgentID, Audience: r.Audience, ChainID: r.ChainID, Nonce: "0x" + strings.Repeat("22", 32), IssuedAt: 1_700_000_000, ExpiresAt: 1_700_000_060}
	challengeHash, err := challengeDigest(c, false)
	if err != nil || hexBytes(challengeHash) != "0xcc0a62bbb07f2774ff53282919ef91ec302742394a18a42d0fb7cfacb6341e65" {
		t.Fatalf("challenge digest: %s, %v", hexBytes(challengeHash), err)
	}
}

func TestSignerRejectsUnsafeObjects(t *testing.T) {
	c := challenge{AgentID: "0x" + strings.Repeat("11", 20), Audience: "https://service-a.example", ChainID: 31337,
		Nonce: "0x" + strings.Repeat("22", 32), IssuedAt: uint64(time.Now().Unix()), ExpiresAt: uint64(time.Now().Unix()) + 60}
	if _, err := challengeDigest(c, true); err != nil {
		t.Fatal(err)
	}
	c.Audience = "http://service-a.example"
	if _, err := challengeDigest(c, true); err == nil {
		t.Fatal("accepted HTTP audience")
	}
	c.Audience = "https://service-a.example"
	c.ExpiresAt = c.IssuedAt - 1
	if _, err := challengeDigest(c, true); err == nil {
		t.Fatal("accepted expired challenge")
	}
	r := request{AgentID: c.AgentID, Audience: c.Audience, ChainID: c.ChainID, Method: "GET", Target: "/report", BodyBase64: base64.StdEncoding.EncodeToString([]byte("secret"))}
	if _, _, err := requestDigest(r, make([]byte, 32), 1, 2); err == nil {
		t.Fatal("accepted GET body")
	}
	r.BodyBase64 = ""
	r.Target = "//attacker.example/report"
	if _, _, err := requestDigest(r, make([]byte, 32), 1, 2); err == nil {
		t.Fatal("accepted authority-form target")
	}
}

func TestLowS(t *testing.T) {
	high := new(big.Int).Sub(order, big.NewInt(1))
	r := make([]byte, 32)
	r[31] = 1
	sig := append(r, high.FillBytes(make([]byte, 32))...)
	normalized, err := lowS(sig)
	if err != nil || normalized[63] != 1 {
		t.Fatalf("high-S normalization failed: %x, %v", normalized, err)
	}
}
