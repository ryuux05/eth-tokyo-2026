import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { install, run } from "../lib/install.js";

// Explicit opt-in: downloads npm runtime dependencies, builds the native signer,
// and reads public Sepolia RPC. Never registers a real client or provisions a key.
test("fresh persistent install, MCP handshake, and idempotent reinstall", {
  skip: process.env.AGENTIC_INSTALLER_SMOKE !== "1",
  timeout: 180_000,
}, async t => {
  const home = await mkdtemp(join(tmpdir(), "agentic-installer-smoke-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "project with spaces");
  await mkdir(cwd);
  const env = { ...process.env, npm_config_cache: join(home, "npm-cache") };
  delete env.AGENTIC_WORLD_RPC_URL;
  let registration;
  let runtimeBuilds = 0;
  const execute = async (command, args, options) => {
    if (command === "codex") {
      if (args[0] === "--version") return { code: 0, stdout: "test client" };
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify(registration ? [registration] : []) };
      assert.equal(args[1], "add");
      assert.equal(registration, undefined, "registration should not be repeated");
      registration = { name: "agentic-world", enabled: true, transport: {
        type: "stdio", command: args.at(-2), args: [args.at(-1)],
        env: { AGENTIC_WORLD_CONFIG: args[4].slice("AGENTIC_WORLD_CONFIG=".length) },
      } };
      return { code: 0, stdout: "" };
    }
    if (command === "npm") runtimeBuilds++;
    return run(command, args, options);
  };
  await install({ client: "codex" }, { home, cwd, env, execute });
  assert.equal(runtimeBuilds, 1);
  const configPath = registration.transport.env.AGENTIC_WORLD_CONFIG;
  const before = await readFile(configPath, "utf8");
  const config = JSON.parse(before);
  assert.equal(config.chainId, 11155111);
  assert.equal(config.agentId, undefined);
  assert.equal(config.agentIds, undefined);
  const server = registration.transport.args[0];
  const runtimePackage = join(server, "../../../../");
  assert.equal((await lstat(runtimePackage)).isSymbolicLink(), false, "must not depend on npx-cache symlink");
  const client = new Client({ name: "installer-smoke", version: "1" });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [server],
      cwd, env: { ...env, AGENTIC_WORLD_CONFIG: configPath }, stderr: "inherit" }));
    const { tools } = await client.listTools();
    assert.ok(tools.some(tool => tool.name === "agentic_session_proof"));
    assert.ok(tools.some(tool => tool.name === "agentic_create_identity"));
    const response = await client.callTool({ name: "agentic_identity", arguments: {} });
    assert.ok(!response.isError);
    assert.equal(JSON.parse(response.content[0].text).configured, false);
  } finally { await client.close(); }
  await install({ client: "codex" }, { home, cwd, env, execute });
  assert.equal(runtimeBuilds, 1, "reinstall should not rebuild the runtime/signer");
  assert.equal(await readFile(configPath, "utf8"), before, "identity config must remain byte-identical");
});
