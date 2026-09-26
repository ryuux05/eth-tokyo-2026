// Test-only software stand-in for the macOS Secure Enclave CLI. This key is public test material.
import { readFileSync } from "node:fs";
import { p256 } from "@noble/curves/nist.js";
import { toBytes } from "viem";
import { createAgentSdk } from "../../sdk/agent.js";

const secret = new Uint8Array(32);
secret[31] = 1;
const publicKey = p256.getPublicKey(secret, false);
const hex = bytes => `0x${Buffer.from(bytes).toString("hex")}`;
const [command, label] = process.argv.slice(2);
if (label !== "test-key" && label !== "tampered") process.exit(1);
if (command === "public-key") {
  console.log(JSON.stringify({ scheme: "p256", qx: hex(publicKey.slice(1, 33)), qy: hex(publicKey.slice(33, 65)) }));
} else if (command === "sign-request") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.kind !== "AgentRequest" || input.label !== label) process.exit(1);
  const signer = createAgentSdk({ agentId: input.agentId, chainId: input.chainId,
    signDigest: async digest => hex(p256.sign(toBytes(digest), secret, { prehash: false }).toCompactRawBytes()) });
  const proof = await signer.signRequest({ method: input.method, target: input.target,
    body: Buffer.from(input.bodyBase64, "base64") }, input.audience);
  console.log(JSON.stringify(label === "tampered" ? { ...proof, target: "/tampered" } : proof));
} else if (command === "sign-challenge") {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (input.kind !== "AgentAuthentication" || input.label !== label) process.exit(1);
  const signer = createAgentSdk({ agentId: input.challenge.agentId, chainId: input.challenge.chainId,
    signDigest: async digest => hex(p256.sign(toBytes(digest), secret, { prehash: false }).toCompactRawBytes()) });
  const proof = await signer.answerChallenge(input.challenge, input.challenge.audience);
  console.log(JSON.stringify(label === "tampered" ? { ...proof, nonce: hex(new Uint8Array(32)) } : proof));
} else process.exit(1);
