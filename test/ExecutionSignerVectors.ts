import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { encodeFunctionData, erc20Abi, toHex, type Address, type Hex } from "viem";
import { encodeAgentExecution } from "../sdk/execution.js";
import { ENTRYPOINT_V08, SEPOLIA_USDC, computePurchaseAbi, executionDigest, executionSigningRequest, type PaymentOperation } from "../sdk/payments.js";

test("native execution digests agree with viem; malformed, excessive and expired requests fail", {
  skip: process.platform !== "darwin" || !existsSync("dist/signer/agentic-signer") ? "Build macOS signer first; no hardware key is required for hashing" : false,
}, () => {
  const temporary = mkdtempSync(join(tmpdir(), "agentic-execution-vectors-"));
  try {
    const go = spawnSync("go", ["build", "-o", join(temporary, "go-signer"), "."], { cwd: "signer/windows", encoding: "utf8" });
    assert.equal(go.status, 0, go.stderr || go.error?.message || "Go signer build failed");
    const binaries = [resolve("dist/signer/agentic-signer"), join(temporary, "go-signer")];
    const sender = "0x1111111111111111111111111111111111111111" as Address;
    const recipient = "0x2222222222222222222222222222222222222222" as Address;
    const validUntil = Math.floor(Date.now() / 1000) + 180;
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [recipient, 5_000_000n] });
    const operation: PaymentOperation = { sender, nonce: 7n, callData: encodeAgentExecution(SEPOLIA_USDC, 0n, data),
      callGasLimit: 200_000n, verificationGasLimit: 200_000n, preVerificationGas: 50_000n,
      maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, signature: "0x" };
    const request = (op = operation) => ({ ...executionSigningRequest(11155111, ENTRYPOINT_V08, op, validUntil), label: "vectors-only" });
    const invoke = (binary: string, input: unknown) => spawnSync(binary, ["hash-execution", "vectors-only"], { input: JSON.stringify(input), encoding: "utf8" });
    const approved = { ...operation, callData: encodeAgentExecution(SEPOLIA_USDC, 0n, data, {
      nonce: 1n, deadline: BigInt(validUntil + 60), signature: `0x${"55".repeat(65)}`,
    }) };
    for (const binary of binaries) {
      const ownerApproval = { nonce: 1n, deadline: BigInt(validUntil + 60), signature: `0x${"55".repeat(65)}` as Hex };
      const purchaseData = encodeFunctionData({ abi: computePurchaseAbi, functionName: "purchaseCompute", args: [SEPOLIA_USDC, 1_000_000n] });
      const purchase = { ...operation, callData: encodeAgentExecution(recipient, 0n, purchaseData) };
      const approvedPurchase = { ...operation, callData: encodeAgentExecution(recipient, 0n, purchaseData, ownerApproval) };
      const allowance = { ...operation, callData: encodeAgentExecution(SEPOLIA_USDC, 0n,
        encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [recipient, 1_000_000n] }), ownerApproval) };
      for (const op of [operation, approved, purchase, approvedPurchase, allowance]) {
        const result = invoke(binary, request(op));
        assert.equal(result.status, 0, result.stderr);
        assert.equal(JSON.parse(result.stdout).digest, executionDigest(11155111, ENTRYPOINT_V08, op, validUntil));
      }
      const good = request();
      const invalid = [
        { ...good, validUntil: 1 }, { ...good, validUntil: validUntil + 301 },
        { ...good, chainId: 1 }, { ...good, entryPoint: recipient },
        request({ ...operation, maxFeePerGas: 100_000_000_001n }),
        request({ ...operation, callGasLimit: 6_000_000n }),
        request({ ...operation, callData: encodeAgentExecution(recipient, 0n, data) }),
        request({ ...operation, callData: encodeAgentExecution(SEPOLIA_USDC, 1n, data) }),
        request({ ...operation, callData: encodeAgentExecution(SEPOLIA_USDC, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [recipient, 5n] })) }),
        request({ ...operation, callData: encodeAgentExecution(SEPOLIA_USDC, 0n, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [recipient, (1n << 256n) - 1n] }), ownerApproval) }),
        request({ ...operation, callData: encodeAgentExecution(recipient, 0n, encodeFunctionData({ abi: computePurchaseAbi, functionName: "purchaseCompute", args: [recipient, 1n] })) }),
        request({ ...operation, callData: `${approved.callData.slice(0, 458)}` as Hex }),
        { ...good, userOperation: { ...good.userOperation, nonce: toHex(1n) } },
      ];
      for (const input of invalid) assert.notEqual(invoke(binary, input).status, 0, "must reject unsafe structured signing input");
    }
  } finally { rmSync(temporary, { recursive: true, force: true }); }
});
