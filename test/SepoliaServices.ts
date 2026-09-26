import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { PublicClient } from "viem";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";
import { resolveSepoliaRpcUrl, verifySepoliaDeployment } from "../scripts/sepolia-runtime.js";

test("Sepolia service RPC selection refuses local chain configs and insecure URLs", async () => {
  assert.equal(await resolveSepoliaRpcUrl({ AGENTIC_SEPOLIA_RPC_URL: "https://rpc.example" }), "https://rpc.example/");
  await assert.rejects(resolveSepoliaRpcUrl({ AGENTIC_SEPOLIA_RPC_URL: "http://127.0.0.1:8545" }), /HTTPS/);
  await assert.rejects(resolveSepoliaRpcUrl({ AGENTIC_SEPOLIA_RPC_URL: "https://user:pass@rpc.example" }), /without embedded credentials/);
  const folder = await mkdtemp(join(tmpdir(), "agentic-sepolia-config-"));
  try {
    const path = join(folder, "config.json");
    await writeFile(path, JSON.stringify({ chainId: 31337, rpcUrl: "http://127.0.0.1:8545" }));
    await assert.rejects(resolveSepoliaRpcUrl({ AGENTIC_WORLD_CONFIG: path }), /must target Sepolia/);
    await writeFile(path, JSON.stringify({ chainId: SEPOLIA_CHAIN_ID, rpcUrl: "https://rpc.example" }));
    assert.equal(await resolveSepoliaRpcUrl({ AGENTIC_WORLD_CONFIG: path }), "https://rpc.example/");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Sepolia services reject a different chain or factory module pins before listening", async () => {
  const client = (chainId: number, validator = SEPOLIA_DEPLOYMENT.validator) => ({
    getChainId: async () => chainId,
    getBytecode: async () => "0x1234",
    readContract: async ({ functionName }: { functionName: string }) => functionName === "implementation"
      ? SEPOLIA_DEPLOYMENT.implementation : functionName === "validator" ? validator : SEPOLIA_DEPLOYMENT.policyHook,
  }) as unknown as PublicClient;
  await verifySepoliaDeployment(client(SEPOLIA_CHAIN_ID));
  await assert.rejects(verifySepoliaDeployment(client(31337)), /not Sepolia/);
  await assert.rejects(verifySepoliaDeployment(client(SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT.factory)), /do not match/);
});
