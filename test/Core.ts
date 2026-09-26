import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { recoverTypedDataAddress, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  Decision,
  agentInitializationTypedData,
  agentRegistrationTypedData,
  authenticationDigest,
  decodePolicy,
  encodePolicy,
  isExpectedDelegation,
  requestAuthenticationDigest,
} from "../sdk/core.js";

describe("Core SDK protocol definitions", () => {
  it("builds root permits for the exact agent, principal, contract, and chain", async () => {
    const root = privateKeyToAccount("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
    const owner = "0x1111111111111111111111111111111111111111";
    const authenticator = "0x2222222222222222222222222222222222222222";
    const registry = "0x3333333333333333333333333333333333333333";
    const init = agentInitializationTypedData({ agent: root.address, owner, authenticator, chainId: 31337, nonce: 0n, deadline: 1000n });
    const initSignature = await root.signTypedData(init);
    assert.equal(await recoverTypedDataAddress({ ...init, signature: initSignature }), root.address);
    const registration = agentRegistrationTypedData({ agent: root.address, principal: owner, registry, chainId: 31337, nonce: 2n, deadline: 2000n });
    const registrationSignature = await root.signTypedData(registration);
    assert.equal(await recoverTypedDataAddress({ ...registration, signature: registrationSignature }), root.address);
    assert.notEqual(authenticationDigest({ agentId: root.address, audience: "https://service-a.example", chainId: 31337,
      nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", issuedAt: 100, expiresAt: 160 }),
    authenticationDigest({ agentId: root.address, audience: "https://service-b.example", chainId: 31337,
      nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", issuedAt: 100, expiresAt: 160 }));
  });

  it("pins delegation and round-trips the versioned policy schema", () => {
    const implementation = "0x4444444444444444444444444444444444444444";
    assert.equal(isExpectedDelegation(`0xef0100${implementation.slice(2)}`, implementation), true);
    assert.equal(isExpectedDelegation("0x", implementation), false);
    const encoded = encodePolicy([{ target: implementation, selector: "0x12345678", token: zeroAddress,
      maxValue: 5n, maxAmount: 0n, decision: Decision.ALLOW }]);
    assert.deepEqual(decodePolicy(encoded), [{ target: implementation, selector: "0x12345678", token: zeroAddress,
      maxValue: 5n, maxAmount: 0n, decision: Decision.ALLOW }]);
  });

  it("binds one-request proofs to method, raw target, body, and audience", () => {
    const base = {
      agentId: "0x1111111111111111111111111111111111111111" as const,
      audience: "https://service-a.example",
      chainId: 31337,
      nonce: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
      issuedAt: 100,
      expiresAt: 160,
      method: "GET",
      target: "/private/report?year=2026",
      bodyHash: "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470" as const,
    };
    const digest = requestAuthenticationDigest(base);
    assert.notEqual(digest, requestAuthenticationDigest({ ...base, method: "POST" }));
    assert.notEqual(digest, requestAuthenticationDigest({ ...base, target: "/private/report?year=2025" }));
    assert.notEqual(digest, requestAuthenticationDigest({ ...base, bodyHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }));
    assert.notEqual(digest, requestAuthenticationDigest({ ...base, audience: "https://service-b.example" }));
  });
});
