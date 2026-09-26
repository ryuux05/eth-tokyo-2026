import { test } from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  const env = { ...process.env, CODEX_HOME: join(home, ".codex"), npm_config_cache: join(home, "npm-cache") };
  delete env.AGENTIC_WORLD_RPC_URL;
  let registration;
  let registrations = 0;
  let runtimeBuilds = 0;
  const execute = async (command, args, options) => {
    if (command === "codex") {
      if (args[0] === "--version") return { code: 0, stdout: "test client" };
      if (args[1] === "list") return { code: 0, stdout: JSON.stringify(registration ? [registration] : []) };
      assert.equal(args[1], "add");
      registrations++;
      registration = { name: "agentic-world", enabled: true, transport: {
        type: "stdio", command: args.at(-2), args: [args.at(-1)],
        env: { AGENTIC_WORLD_CONFIG: args[4].slice("AGENTIC_WORLD_CONFIG=".length) },
      } };
      // Model the real CLI write: verification must not classify its own new
      // user registration as a project override.
      await mkdir(env.CODEX_HOME, { recursive: true });
      await writeFile(join(env.CODEX_HOME, "config.toml"), '[mcp_servers.agentic-world]\ncommand = "node"\n');
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
  assert.equal(registrations, 1, "reinstall should reuse the existing registration");

  // Model an installed 0.0.2 runtime, signer and unmodified installer skill.
  const oldRoot = join(dirname(configPath), "runtime/0.0.2");
  const oldPackage = join(oldRoot, "node_modules/agenticworld");
  const oldServer = join(oldPackage, "runtime/dist/mcp/server.js");
  const oldSigner = join(oldPackage, "runtime/dist/signer", config.signer.binaryPath.endsWith(".exe") ? "agentic-signer.exe" : "agentic-signer");
  await mkdir(dirname(oldServer), { recursive: true });
  await mkdir(dirname(oldSigner), { recursive: true });
  await writeFile(oldServer, "// old installer runtime fixture");
  await cp(config.signer.binaryPath, oldSigner);
  await writeFile(join(oldRoot, "ready.json"), JSON.stringify({ version: "0.0.2" }));
  await writeFile(join(oldPackage, "package.json"), JSON.stringify({ name: "agenticworld", version: "0.0.2" }));
  const skillPath = join(home, ".agents/skills/agentic-world/SKILL.md");
  const newSkill = await readFile(skillPath, "utf8");
  const oldSkill = "---\nname: agentic-world\ndescription: Previous release fixture\n---\n";
  await mkdir(join(oldPackage, "skills/codex"), { recursive: true });
  await writeFile(join(oldPackage, "skills/codex/SKILL.md"), oldSkill);
  await writeFile(skillPath, oldSkill);
  const oldConfig = { ...config, aliases: { "0x1111111111111111111111111111111111111111": "retained" },
    signer: { ...config.signer, binaryPath: oldSigner } };
  await writeFile(configPath, JSON.stringify(oldConfig));
  registration.transport.args = [oldServer];
  await install({ client: "codex" }, { home, cwd, env, execute });
  assert.equal(runtimeBuilds, 1);
  assert.equal(registrations, 2, "managed upgrade updates registration once");
  assert.equal(registration.transport.args[0], server);
  assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")), { ...oldConfig, signer: config.signer });
  assert.equal(await readFile(skillPath, "utf8"), newSkill, "upgrade refreshes the installer-owned skill");
});
