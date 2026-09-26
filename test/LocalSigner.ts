import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { keccak256, toBytes, type Address } from "viem";
import { authenticationDigest, requestAuthenticationDigest, type AuthenticationChallenge } from "../sdk/core.js";
import { signLocalChallenge, signLocalRequest, signerPublicKey } from "../mcp/local-signer.js";

describe("Local signer bridge", () => {
  it("checks the structured proof returned by a separate signer process", { skip: process.platform === "win32" ? "POSIX fixture launcher; Windows TPM helper has separate protocol-vector tests" : false }, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "agentic-signer-test-"));
    try {
      const fixture = fileURLToPath(new URL("../scripts/demo/LocalSignerFixture.mjs", import.meta.url));
      const launcher = join(temporary, "signer");
      await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" --import tsx "${fixture}" "$@"\n`);
      await chmod(launcher, 0o700);
      const config = { binaryPath: launcher, label: "test-key" };
      const key = await signerPublicKey(config);
      const publicKey = new Uint8Array([4, ...toBytes(key.qx), ...toBytes(key.qy)]);
      const agentId = "0x1111111111111111111111111111111111111111" as Address;
      const proof = await signLocalRequest(config, { agentId, chainId: 31337 }, {
        audience: "https://service-a.example", method: "POST", target: "/report?format=json",
        body: new TextEncoder().encode('{"ok":true}'),
      });
      assert.equal(proof.bodyHash, keccak256(toBytes('{"ok":true}')));
      assert.equal(proof.expiresAt - proof.issuedAt, 60);
      assert.equal(p256.verify(toBytes(proof.signature), toBytes(requestAuthenticationDigest(proof)), publicKey), true);
      const issuedAt = Math.floor(Date.now() / 1000);
      const challenge: AuthenticationChallenge = { agentId, chainId: 31337, audience: "https://service-a.example",
        nonce: `0x${"22".repeat(32)}`, issuedAt, expiresAt: issuedAt + 60 };
      const sessionProof = await signLocalChallenge(config, challenge);
      assert.equal(sessionProof.nonce, challenge.nonce);
      assert.equal(p256.verify(toBytes(sessionProof.signature), toBytes(authenticationDigest(challenge)), publicKey), true);
      await assert.rejects(signLocalChallenge({ binaryPath: launcher, label: "tampered" }, challenge), /mismatched challenge proof/);
      await assert.rejects(signLocalRequest({ binaryPath: launcher, label: "tampered" }, { agentId, chainId: 31337 }, {
        audience: "https://service-b.example", method: "GET", target: "/other", body: new Uint8Array(),
      }), /mismatched request proof/);
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
});
