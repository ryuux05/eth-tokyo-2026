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
    const options = { configPath, signerBinaryPath, rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com" };
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
