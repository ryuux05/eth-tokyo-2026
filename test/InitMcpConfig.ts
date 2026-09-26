import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeMcpConfig } from "../scripts/init-mcp-config.js";
import { SEPOLIA_CHAIN_ID } from "../sdk/deployments.js";

test("MCP init creates a private Sepolia config and never overwrites an existing one", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-world-config-test-"));
  try {
    const signerBinaryPath = join(directory, "signer");
    const configPath = join(directory, "settings", "config.json");
    await writeFile(signerBinaryPath, "test signer");
    const options = { configPath, signerBinaryPath, rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com", readChainId: async () => SEPOLIA_CHAIN_ID };
    assert.deepEqual(await initializeMcpConfig(options), { path: configPath, created: true });
    const contents = await readFile(configPath, "utf8");
    const config = JSON.parse(contents);
    assert.equal(config.chainId, SEPOLIA_CHAIN_ID);
    assert.equal(config.factory, undefined);
    assert.equal(config.implementation, undefined);
    assert.equal(config.signer.binaryPath, signerBinaryPath);
    assert.deepEqual(await initializeMcpConfig(options), { path: configPath, created: false });
    assert.equal(await readFile(configPath, "utf8"), contents);
    await writeFile(configPath, '{"chainId":31337}');
    await assert.rejects(initializeMcpConfig(options), /Existing MCP config is invalid/);
    assert.equal(await readFile(configPath, "utf8"), '{"chainId":31337}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("init selects and validates an RPC; explicit updates preserve all identity and signer data", {
  skip: process.platform !== "darwin" && process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentic-world-rpc-test-"));
  try {
    const signerBinaryPath = join(directory, "signer");
    const configPath = join(directory, "config.json");
    await writeFile(signerBinaryPath, "test signer");
    const rpcUrl = "https://provider.example/sepolia/private-key";
    let checked = "";
    const options = { configPath, signerBinaryPath, rpcUrl,
      readChainId: async (url: string) => { checked = url; return SEPOLIA_CHAIN_ID; } };
    await assert.rejects(initializeMcpConfig({ ...options, rpcUrl: "http://provider.example" }), /HTTPS/);
    await assert.rejects(initializeMcpConfig({ ...options, readChainId: async () => 1 }), /11155111/);
    await assert.rejects(readFile(configPath), { code: "ENOENT" });
    await initializeMcpConfig(options);
    assert.equal(checked, rpcUrl);
    const config = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(config.rpcUrl, rpcUrl);
    const id = "0x1111111111111111111111111111111111111111";
    config.agentId = id; config.agentIds = [id]; config.aliases = { [id]: "Keep me" };
    config.authenticatorLabels = { [id]: ["original", "rotated"] };
    const original = JSON.stringify(config);
    await writeFile(configPath, original);
    const replacement = { ...options, rpcUrl: "https://other.example/sepolia" };
    await assert.rejects(initializeMcpConfig(replacement), /--update-rpc/);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(initializeMcpConfig({ ...replacement, updateRpc: true, readChainId: async () => 31337 }), /11155111/);
    assert.equal(await readFile(configPath, "utf8"), original);
    await assert.rejects(initializeMcpConfig({ ...replacement, updateRpc: true,
      readChainId: async () => { throw new Error(`Credentials failed at ${rpcUrl}`); } }), error => {
      assert(error instanceof Error);
      assert(!error.message.includes("private-key"));
      return true;
    });
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.deepEqual(await initializeMcpConfig({ ...replacement, updateRpc: true }), { path: configPath, created: false, rpcUpdated: true });
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...config, rpcUrl: replacement.rpcUrl });
    await assert.rejects(initializeMcpConfig({ ...options, rpcUrl: undefined, updateRpc: true }), /explicit/);
    const before = await readFile(configPath, "utf8");
    await initializeMcpConfig({ ...options, rpcUrl: undefined });
    assert.equal(await readFile(configPath, "utf8"), before, "ordinary init must retain a custom endpoint");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
