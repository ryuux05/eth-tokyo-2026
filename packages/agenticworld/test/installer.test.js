import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { parseArguments, planSkill, planRegistration, dataDirectory, sameEntry, sameProjectPath, run } from "../lib/install.js";

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "agentic-installer-test-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const cwd = join(home, "project with spaces");
  await mkdir(cwd);
  return { home, cwd, env: {}, nodePath: process.execPath, server: join(home, "MCP files/server.js"), configPath: join(home, "private/config.json") };
}
async function put(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
const skill = "---\nname: agentic-world\ndescription: Test fixture\n---\n";
const entry = c => ({ type: "stdio", command: c.nodePath, args: [c.server], env: { AGENTIC_WORLD_CONFIG: c.configPath } });

test("CLI supports default install, explicit clients and private RPC updates; rejects unknown options", () => {
  assert.deepEqual(parseArguments([]), {});
  assert.deepEqual(parseArguments(["install", "--client", "both", "--rpc", "https://rpc.example", "--update-rpc"]), { client: "both", rpc: "https://rpc.example", updateRpc: true });
  for (const args of [["--client", "all"], ["install", "--rpc"], ["remove"], ["--client", "codex", "--client", "claude"]]) assert.throws(() => parseArguments(args));
});
test("platform locations preserve existing config paths; Linux is rejected", () => {
  assert.match(dataDirectory("darwin", "/user", {}), /Library\/Application Support\/AgenticWorld$/);
  assert.equal(dataDirectory("win32", "/user", { LOCALAPPDATA: "/appdata" }), "/appdata/AgenticWorld");
  assert.throws(() => dataDirectory("linux", "/user", {}), /Linux\/WSL/);
});
test("new Codex skill uses one canonical personal directory", async t => {
  const c = await fixture(t);
  const result = await planSkill("codex", c);
  assert.equal(result.path, join(c.home, ".agents/skills/agentic-world"));
  assert.equal(result.reuse, false);
});
test("reuse an existing legacy or project skill without installing a duplicate", async t => {
  const c = await fixture(t);
  const path = join(c.home, ".codex/skills/renamed-folder");
  await put(join(path, "SKILL.md"), skill);
  assert.equal((await planSkill("codex", c)).path, path);
  await put(join(c.cwd, ".agents/skills/agentic-world/SKILL.md"), skill);
  await assert.rejects(planSkill("codex", c), /Duplicate codex skills/);
  assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), skill);
});
test("unreadable existing canonical skill is not overwritten", async t => {
  const c = await fixture(t);
  await mkdir(join(c.home, ".claude/skills/agentic-world"), { recursive: true });
  await assert.rejects(planSkill("claude", c), /not a readable skill/);
});
test("Codex registration uses absolute paths and reuses only exact enabled entries", async t => {
  const c = await fixture(t);
  const empty = async () => ({ stdout: "[]", code: 0 });
  const result = await planRegistration("codex", c, empty);
  assert.equal(result.reuse, false);
  assert.deepEqual(result.args.slice(-3), ["--", process.execPath, c.server]);
  const existing = { name: "agentic-world", enabled: true, transport: entry(c) };
  assert.equal((await planRegistration("codex", c, async () => ({ stdout: JSON.stringify([existing]) }))).reuse, true);
  existing.enabled = false;
  await assert.rejects(planRegistration("codex", c, async () => ({ stdout: JSON.stringify([existing]) })), /disabled/);
  assert.equal(sameEntry({ ...entry(c), args: ["other.js"] }, c.server, c.configPath, c.nodePath), false);
});
test("Codex user registration remains reusable after its config file is written", async t => {
  const c = await fixture(t);
  const existing = { name: "agentic-world", enabled: true, transport: entry(c) };
  const lookup = async () => ({ stdout: JSON.stringify([existing]) });
  await put(join(c.home, ".codex/config.toml"), '[mcp_servers.agentic-world]\ncommand = "node"');
  assert.equal((await planRegistration("codex", c, lookup)).reuse, true);
  // Installing from the home directory must work too.
  assert.equal((await planRegistration("codex", { ...c, cwd: c.home }, lookup)).reuse, true);
  existing.enabled = false;
  await assert.rejects(planRegistration("codex", c, lookup), /disabled/);
});
test("Codex custom user config in an ancestor is not mistaken for a project override", async t => {
  const c = await fixture(t);
  c.env.CODEX_HOME = join(c.cwd, ".codex");
  await put(join(c.env.CODEX_HOME, "config.toml"), '[mcp_servers."agentic-world"]\ncommand = "node"');
  const existing = { name: "agentic-world", enabled: true, transport: entry(c) };
  assert.equal((await planRegistration("codex", c, async () => ({ stdout: JSON.stringify([existing]) }))).reuse, true);
});
test("Codex project override is reported rather than silently shadowing user configuration", async t => {
  const c = await fixture(t);
  await put(join(c.cwd, ".codex/config.toml"), '[mcp_servers."agentic-world"]\ncommand = "other"');
  await assert.rejects(planRegistration("codex", c, async () => { throw new Error("must not run"); }), /Project MCP override/);
});
test("Codex upgrades a verified installer runtime while preserving custom or disabled entries", async t => {
  const c = await fixture(t);
  const prefix = join(dirname(c.configPath), "runtime/0.0.2");
  const oldServer = join(prefix, "node_modules/agenticworld/runtime/dist/mcp/server.js");
  const existing = { name: "agentic-world", enabled: true, transport: { ...entry(c), args: [oldServer] } };
  const lookup = async () => ({ stdout: JSON.stringify([existing]) });
  await put(oldServer, "// Previous installed server");
  await put(join(prefix, "ready.json"), { version: "0.0.2" });
  await put(join(prefix, "node_modules/agenticworld/package.json"), { name: "agenticworld", version: "0.0.2" });
  const planned = await planRegistration("codex", c, lookup);
  assert.equal(planned.upgrade, true);
  assert.equal(planned.reuse, false);
  assert.equal(planned.args.at(-1), c.server);
  existing.enabled = false;
  await assert.rejects(planRegistration("codex", c, lookup), /disabled/);
  existing.enabled = true;
  existing.enabled_tools = ["agentic_identity"];
  await assert.rejects(planRegistration("codex", c, lookup), /different/);
  delete existing.enabled_tools;
  existing.transport.env.EXTRA = "preserve-me";
  await assert.rejects(planRegistration("codex", c, lookup), /different/);
  delete existing.transport.env.EXTRA;
  await rm(join(prefix, "ready.json"));
  await assert.rejects(planRegistration("codex", c, lookup), /different/);
});
test("Claude uses user scope normally, local scope for a checked-in MCP override", async t => {
  const c = await fixture(t);
  assert.equal((await planRegistration("claude", c)).scope, "user");
  await put(join(c.cwd, ".mcp.json"), { mcpServers: { "agentic-world": { command: "node", args: ["dist/mcp/server.js"] } } });
  await put(join(c.cwd, ".claude/settings.local.json"), { disabledMcpjsonServers: ["agentic-world"] });
  const plan = await planRegistration("claude", c);
  assert.equal(plan.scope, "local");
  assert.equal(plan.reuse, false);
  await put(join(c.home, ".claude.json"), { projects: { [c.cwd]: { mcpServers: { "agentic-world": entry(c) } } } });
  assert.equal((await planRegistration("claude", c)).reuse, true);
});
test("Claude conflicting or invalid private configuration is preserved", async t => {
  const c = await fixture(t);
  const path = join(c.home, ".claude.json");
  await put(path, { mcpServers: { "agentic-world": { command: "other" }, untouched: { command: "keep" } } });
  const before = await readFile(path, "utf8");
  await assert.rejects(planRegistration("claude", c), /different/);
  assert.equal(await readFile(path, "utf8"), before);
  await put(path, "invalid JSON");
  await assert.rejects(planRegistration("claude", c), /left unchanged/);
});
test("Claude Windows project paths normalize slashes and drive casing", () => {
  assert.equal(sameProjectPath("D:/Projects/Agent", "d:\\projects\\agent"), true);
  assert.equal(sameProjectPath("/Projects/Agent", "/projects/agent"), false);
});
test("Claude project override is discovered from a child directory", async t => {
  const c = await fixture(t);
  await put(join(c.cwd, ".mcp.json"), { mcpServers: { "agentic-world": { command: "node" } } });
  c.cwd = join(c.cwd, "src");
  await mkdir(c.cwd);
  assert.equal((await planRegistration("claude", c)).scope, "local");
});
test("Claude explicit user disable is not silently overridden", async t => {
  const c = await fixture(t);
  await put(join(c.home, ".claude.json"), { projects: { [c.cwd]: { disabledMcpServers: ["agentic-world"] } } });
  await assert.rejects(planRegistration("claude", c), /explicitly disabled/);
});
test("subprocess execution preserves spaces and shell metacharacters without executing them", async () => {
  const value = "path with spaces & echo bad; $(bad)";
  const result = await run(process.execPath, ["-e", "process.stdout.write(process.argv[1])", value]);
  assert.equal(result.stdout, value);
});
