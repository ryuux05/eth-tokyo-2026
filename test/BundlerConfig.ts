import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureBundler, parseBundlerArguments, validateBundler } from "../mcp/bundler-config.js";
import { SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";

const url = "https://bundler.example/rpc?apikey=private-test-value";
const responses: Record<string, unknown> = {
  eth_chainId: "0xaa36a7", eth_supportedEntryPoints: [SEPOLIA_DEPLOYMENT.entryPoint],
  pimlico_getUserOperationGasPrice: { standard: { maxFeePerGas: "0x20", maxPriorityFeePerGas: "0x1" } },
};
const request = async (_url: string, method: string) => responses[method];
const hardwareHost = process.platform === "darwin" || process.platform === "win32";

async function fixture(fn: (path: string, directory: string, document: any) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "agentic-bundler-config-"));
  const path = join(directory, "config.json");
  const id = "0x1111111111111111111111111111111111111111";
  const document = { rpcUrl: "https://read.example", chainId: 11155111,
    signer: { kind: process.platform === "win32" ? "windows-tpm" : "secure-enclave", binaryPath: join(directory, "signer"), label: "keep-key" },
    agentId: id, agentIds: [id], aliases: { [id]: "Keep alias" }, authenticatorLabels: { [id]: ["old-key", "new-key"] },
    execution: { bundlerRpcUrl: "https://previous.example", maxGasCostWei: "120000" } };
  try { await writeFile(path, JSON.stringify(document)); await fn(path, directory, document); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

test("bundler configuration saves and replaces the endpoint while preserving private identity state", { skip: !hardwareHost }, async () => {
  await fixture(async (path, directory, document) => {
    const methods: string[] = [];
    const result = await configureBundler({ configPath: path, bundlerRpcUrl: url, request: async (endpoint, method) => {
      assert.equal(endpoint, url); methods.push(method); return responses[method];
    } });
    assert.equal(result.configured, true);
    assert(!JSON.stringify(result).includes("private-test-value"));
    assert.deepEqual(methods.sort(), Object.keys(responses).sort(), "only read-only bundler probes are made");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...document, execution: { ...document.execution, bundlerRpcUrl: url } });
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    const replacement = "https://replacement.example/rpc";
    await configureBundler({ configPath: path, bundlerRpcUrl: replacement, request });
    assert.equal(JSON.parse(await readFile(path, "utf8")).execution.bundlerRpcUrl, replacement);
    assert.deepEqual(await readdir(directory), ["config.json"]);
    delete document.execution;
    await writeFile(path, JSON.stringify(document));
    await configureBundler({ configPath: path, bundlerRpcUrl: url, request });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), { ...document, execution: { bundlerRpcUrl: url } });
  });
});

test("failed bundler validation leaves the config byte-for-byte unchanged and redacts provider errors", { skip: !hardwareHost }, async () => {
  await fixture(async (path, directory) => {
    const original = await readFile(path, "utf8");
    for (const [method, value, expected] of [
      ["eth_chainId", "0x1", /Sepolia/],
      ["eth_supportedEntryPoints", [], /EntryPoint/],
      ["pimlico_getUserOperationGasPrice", {}, /gas-price/],
    ] as const) {
      await assert.rejects(configureBundler({ configPath: path, bundlerRpcUrl: url,
        request: async (_url, name) => name === method ? value : responses[name] }), expected);
      assert.equal(await readFile(path, "utf8"), original);
    }
    await assert.rejects(configureBundler({ configPath: path, bundlerRpcUrl: url,
      request: async () => { throw new Error(`Provider failed: ${url}`); } }), error => {
      assert(error instanceof Error); assert(!error.message.includes("private-test-value")); return true;
    });
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(await readdir(directory), ["config.json"]);
  });
});

test("configuration refuses a concurrent edit and requires an existing initialized config", { skip: !hardwareHost }, async () => {
  await fixture(async (path, directory, document) => {
    const changed = JSON.stringify({ ...document, aliases: {} });
    await assert.rejects(configureBundler({ configPath: path, bundlerRpcUrl: url,
      request: async (_url, method) => {
        if (method === "eth_chainId") await writeFile(path, changed);
        return responses[method];
      } }), /changed during setup/);
    assert.equal(await readFile(path, "utf8"), changed);
    await writeFile(`${path}.bundler.lock`, "other command");
    await assert.rejects(configureBundler({ configPath: path, bundlerRpcUrl: url, request }), /locked/);
    await assert.rejects(configureBundler({ configPath: join(directory, "missing.json"), bundlerRpcUrl: url, request }), /Run init first/);
    await writeFile(path, "not-json");
    await assert.rejects(configureBundler({ configPath: path, bundlerRpcUrl: url, request }), /valid Sepolia/);
    assert.equal(await readFile(path, "utf8"), "not-json");
  });
});

test("bundler validation rejects unsafe URLs before contacting them", async () => {
  for (const endpoint of ["http://example.com", "https://name:password@example.com", "https://example.com/#secret", "not a url"]) {
    await assert.rejects(validateBundler(endpoint, async () => { assert.fail("must not send a request"); }), /HTTPS URL/);
  }
  assert.deepEqual(parseBundlerArguments(["--config", "/tmp/config.json", "--bundler-rpc", url]), { config: "/tmp/config.json", url });
  assert.throws(() => parseBundlerArguments([url]), /Unknown/);
  assert.throws(() => parseBundlerArguments(["--bundler-rpc"]), /incomplete/);
});
