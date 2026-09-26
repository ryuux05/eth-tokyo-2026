import assert from "node:assert/strict";
import { it } from "node:test";
import { p256 } from "@noble/curves/nist.js";
import { toHex } from "viem";
import { validP256PublicKey } from "../portal/p256.js";

it("accepts Secure Enclave-style P-256 public coordinates and rejects invalid points", () => {
  const publicKey = p256.getPublicKey(p256.utils.randomPrivateKey(), false);
  const qx = toHex(publicKey.slice(1, 33));
  const qy = toHex(publicKey.slice(33, 65));
  assert.equal(validP256PublicKey(qx, qy), true);
  assert.equal(validP256PublicKey(qx.slice(0, -2), qy), false);
  assert.equal(validP256PublicKey(`0x${"00".repeat(32)}`, `0x${"00".repeat(32)}`), false);
});
