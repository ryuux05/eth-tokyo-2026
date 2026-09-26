import spawn from "cross-spawn";
import { access, cp, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const name = "agentic-world";

export function parseArguments(args) {
  const result = {};
  if (args[0] === "install" || args[0] === "init") args = args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") result.help = true;
    else if (arg === "--update-rpc") result.updateRpc = true;
    else if (["--client", "--rpc"].includes(arg) && args[i + 1] && !args[i + 1].startsWith("--")) {
      const key = arg.slice(2);
      if (result[key]) throw new Error(`Repeated option ${arg}`);
      result[key] = args[++i];
    } else throw new Error("Unknown or incomplete argument. Run agenticworld --help.");
  }
  if (result.client && !["codex", "claude", "both"].includes(result.client)) throw new Error("--client must be codex, claude, or both");
  return result;
}

export async function exists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function json(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw new Error(`Cannot read valid JSON at ${path}; left unchanged`); }
}

export function run(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout?.on("data", data => { stdout += data; });
    // Do not echo arbitrary CLI diagnostics: they can include RPC credentials.
    child.stderr?.on("data", () => {});
    child.once("error", error => {
      if (options.allowFailure) resolveResult({ code: -1, stdout: "", missing: error.code === "ENOENT" });
      else reject(new Error(`Could not start ${command}. Check that it is installed and on PATH.`));
    });
    child.once("close", code => {
      if (code !== 0 && !options.allowFailure) reject(new Error(`${command} failed (${code}). No existing identity or client entry was removed.`));
      else resolveResult({ code, stdout });
    });
  });
}

export function dataDirectory(platform, home, env) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "AgenticWorld");
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "AgenticWorld");
  throw new Error("Hardware-backed signing currently requires macOS or Windows; Linux/WSL is not supported. On Windows use native PowerShell.");
}

function ancestors(cwd, home) {
  const paths = [];
  for (let path = resolve(cwd); ; path = dirname(path)) {
    paths.push(path);
    if (path === dirname(path) || path === home) break;
  }
  return paths;
}

// Inspect both current and legacy locations, plus project skills. Even differently
// named folders can declare the same skill name and appear twice in the selector.
export async function planSkill(client, { home, cwd, env }) {
  const personal = client === "codex" ? join(home, ".agents", "skills") : join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "skills");
  const roots = new Set([personal, ...ancestors(cwd, home).map(path => join(path, client === "codex" ? ".agents" : ".claude", "skills"))]);
  if (client === "codex") roots.add(join(env.CODEX_HOME || join(home, ".codex"), "skills"));
  const found = [];
  for (const root of roots) {
    let entries;
    try { entries = await readdir(root); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        const source = await readFile(join(path, "SKILL.md"), "utf8");
        if (/^name:\s*["']?agentic-world["']?\s*$/m.test(source.split("---")[1] ?? "")) found.push(path);
      } catch (error) {
        if (entry === name) throw new Error(`Existing ${path} is not a readable skill; repair it before installing`);
        if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
      }
    }
  }
  if (found.length > 1) throw new Error(`Duplicate ${client} skills found. Keep one before retrying:\n${found.join("\n")}`);
  return { client, path: found[0] ?? join(personal, name), reuse: found.length === 1 };
}

export function sameEntry(entry, server, configPath, nodePath) {
  const transport = entry?.transport ?? entry;
  return entry?.enabled !== false && transport?.type !== "http" &&
    [nodePath, "node"].includes(transport?.command) &&
    transport?.args?.length === 1 && transport.args[0] === server &&
    transport?.env?.AGENTIC_WORLD_CONFIG === configPath;
}

// Claude may persist Windows project paths using forward slashes/drive casing.
export function sameProjectPath(a, b) {
  const normalize = path => path.replaceAll("\\", "/").replace(/\/$/, "");
  const left = normalize(a), right = normalize(b);
  return /^[a-z]:\//i.test(left) && /^[a-z]:\//i.test(right)
    ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// Only update a registration created by this installer. Custom commands,
// credentials, disabled entries, and tool restrictions still need reconciliation.
async function managedCodexEntry(entry, { configPath }) {
  const transport = entry?.transport ?? entry;
  if (entry?.enabled === false || entry?.enabled_tools != null || entry?.disabled_tools != null ||
      transport?.type !== "stdio" || transport.cwd || transport.env_vars?.length ||
      Object.keys(transport.env ?? {}).length !== 1 || transport.env?.AGENTIC_WORLD_CONFIG !== configPath ||
      transport.args?.length !== 1 || !isAbsolute(transport.args[0]) ||
      !(transport.command === "node" || (isAbsolute(transport.command ?? "") && /^node(?:\.exe)?$/i.test(basename(transport.command))))) return false;
  const parts = relative(join(dirname(configPath), "runtime"), transport.args[0]).split(sep);
  if (parts.length !== 7 || !/^\d+\.\d+\.\d+$/.test(parts[0]) ||
      parts.slice(1).join("/") !== "node_modules/agenticworld/runtime/dist/mcp/server.js") return false;
  const prefix = join(dirname(configPath), "runtime", parts[0]);
  const ready = await json(join(prefix, "ready.json"), {});
  const pkg = await json(join(prefix, "node_modules/agenticworld/package.json"), {});
  return ready.version === parts[0] && pkg.name === "agenticworld" && pkg.version === parts[0] && await exists(transport.args[0]);
}

export async function planRegistration(client, context, execute = run) {
  const { home, cwd, env, server, configPath, nodePath } = context;
  if (client === "codex") {
    const userConfig = resolve(env.CODEX_HOME || join(home, ".codex"), "config.toml");
    for (const path of ancestors(cwd, home)) {
      const config = join(path, ".codex", "config.toml");
      // The ancestor scan includes home. Its user entry is inspected by the CLI
      // below, including immediately after we register it during a fresh install.
      if (sameProjectPath(resolve(config), userConfig)) continue;
      if (await exists(config) && /^\s*\[mcp_servers\.(?:agentic-world|"agentic-world"|'agentic-world')(?:\]|\.)/m.test(await readFile(config, "utf8")))
        throw new Error(`Project MCP override at ${config}; reconcile it before installing a user entry`);
    }
    const result = await execute("codex", ["mcp", "list", "--json"], { cwd: home, env });
    let entries;
    try { entries = JSON.parse(result.stdout); if (!Array.isArray(entries)) throw new Error(); }
    catch { throw new Error("Could not inspect Codex MCP entries; no registration was changed"); }
    const entry = entries.find(item => item.name === name);
    const reuse = !!entry && sameEntry(entry, server, configPath, nodePath);
    if (entry && !reuse && !await managedCodexEntry(entry, context)) throw new Error("Codex already has a different or disabled agentic-world MCP. Reconcile it explicitly; the installer will not replace it.");
    return { client, reuse, upgrade: !!entry && !reuse, args: ["mcp", "add", name, "--env", `AGENTIC_WORLD_CONFIG=${configPath}`, "--", nodePath, server] };
  }
  const claudePath = env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(home, ".claude.json");
  const settings = await json(claudePath, {});
  const projectSettings = Object.entries(settings.projects ?? {}).find(([path]) => sameProjectPath(path, cwd))?.[1];
  if (settings.disabledMcpServers?.includes(name) || projectSettings?.disabledMcpServers?.includes(name))
    throw new Error("Claude has explicitly disabled agentic-world. Re-enable it intentionally before installing; the installer will not override that choice.");
  const localEntry = projectSettings?.mcpServers?.[name];
  const userEntry = settings.mcpServers?.[name];
  let projectEntry;
  for (const path of ancestors(cwd, home)) {
    const project = await json(join(path, ".mcp.json"), {});
    if (project.mcpServers?.[name]) { projectEntry = project.mcpServers[name]; break; }
    if (await exists(join(path, ".git"))) break;
  }
  const scope = localEntry || projectEntry ? "local" : "user";
  // Check both private scopes, even if one is shadowed. Never silently migrate.
  for (const entry of [localEntry, userEntry]) {
    if (entry && !sameEntry(entry, server, configPath, nodePath)) throw new Error("Claude already has a different agentic-world MCP registration. Reconcile it explicitly; nothing was replaced.");
  }
  return { client, scope, reuse: !!(scope === "local" ? localEntry : userEntry), args: ["mcp", "add", "--scope", scope, "--transport", "stdio", name,
    "--env", `AGENTIC_WORLD_CONFIG=${configPath}`, "--", nodePath, server] };
}

// Context injection permits installation tests without changing real home/client settings.
export async function install(options = {}, { home = homedir(), cwd = process.cwd(), env = process.env, execute = run } = {}) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required");
  const data = dataDirectory(process.platform, home, env);
  if (process.platform === "win32" && !["x64", "arm64"].includes(process.arch)) throw new Error("Windows requires x64 or ARM64");
  await import("./check-package.js");
  const clients = [];
  for (const client of ["codex", "claude"]) {
    if (options.client && options.client !== "both" && options.client !== client) continue;
    const result = await execute(client, ["--version"], { allowFailure: true, env });
    if (result.code === 0) clients.push(client);
    else if (options.client) throw new Error(`Install the ${client} CLI and make it available on PATH first`);
  }
  if (!clients.length) throw new Error("No Codex or Claude Code CLI found on PATH. Install one, then rerun.");
  const { version } = await json(join(packageRoot, "package.json"));
  const prefix = join(data, "runtime", version);
  const installed = join(prefix, "node_modules", "agenticworld");
  const runtime = join(installed, "runtime");
  const server = join(runtime, "dist", "mcp", "server.js");
  const configPath = join(data, "config.json");
  const context = { home, cwd, env, server, configPath, nodePath: process.execPath };
  const skills = await Promise.all(clients.map(client => planSkill(client, context)));
  const registrations = await Promise.all(clients.map(client => planRegistration(client, context, execute)));
  const rpcUrl = options.rpc ?? env.AGENTIC_WORLD_RPC_URL;
  if (rpcUrl) {
    try { if (new URL(rpcUrl).protocol !== "https:") throw new Error(); }
    catch { throw new Error("RPC must be a valid HTTPS URL"); }
  }
  if (options.updateRpc && !rpcUrl) throw new Error("--update-rpc requires --rpc or AGENTIC_WORLD_RPC_URL");
  console.log(`Installing for ${clients.join(" + ")}. Runtime: ${prefix}`);
  await mkdir(data, { recursive: true, mode: 0o700 });
  const lockPath = join(data, ".install.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Another installation may be running. If it has stopped, remove the stale lock at ${lockPath} and retry.`);
    throw error;
  }
  try {
    await lock.writeFile(String(process.pid));
    const ready = join(prefix, "ready.json");
    if (!await exists(ready)) {
      await mkdir(prefix, { recursive: true, mode: 0o700 });
      // --install-links copies a local/npx package instead of symlinking into the
      // disposable npx cache. Runtime dependencies only; no lifecycle scripts.
      await execute("npm", ["install", "--prefix", prefix, "--install-links", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund", "--package-lock=false", packageRoot], { inherit: true, env });
      await execute(process.execPath, [join(runtime, "scripts", "build-signer.mjs")], { inherit: true, env });
      await writeFile(ready, JSON.stringify({ version }), { mode: 0o600 });
    }
    await access(server);
    const signerBinaryPath = join(runtime, "dist", "signer", `agentic-signer${process.platform === "win32" ? ".exe" : ""}`);
    const { initializeMcpConfig } = await import(pathToFileURL(join(runtime, "dist", "scripts", "init-mcp-config.js")).href);
    await initializeMcpConfig({ configPath, signerBinaryPath, rpcUrl, updateRpc: options.updateRpc });
    // Recheck immediately before writes: another process/user may have changed a
    // client config while the runtime was building. Use each client's own CLI.
    for (const planned of registrations) {
      const current = await planRegistration(planned.client, context, execute);
      if (!current.reuse) await execute(current.client, current.args, { cwd, env });
      const verified = await planRegistration(current.client, context, execute);
      if (!verified.reuse) throw new Error(`${current.client} registration could not be verified; restart installation after inspecting its MCP settings`);
      console.log(`${current.client}: MCP ${current.reuse ? "already registered" : current.upgrade ? "updated to this runtime" : `registered${current.scope ? ` (${current.scope})` : ""}`}.`);
    }
    for (const planned of skills) {
      const current = await planSkill(planned.client, context);
      if (!current.reuse) {
        await mkdir(dirname(current.path), { recursive: true });
        // Do not merge with or overwrite an unrelated/manual skill directory.
        await mkdir(current.path);
        await cp(join(installed, "skills", current.client, "SKILL.md"), join(current.path, "SKILL.md"), { force: false, errorOnExist: true });
      }
      console.log(`${current.client}: skill ${current.reuse ? "reused at" : "installed at"} ${current.path}`);
    }
    console.log(`Ready. Config: ${configPath}\nRestart Codex/Claude Code, then say: agentic-world:create -a "My agent"\nNo key or identity was created. Existing agents and RPC settings were preserved unless you explicitly updated the RPC.`);
  } finally {
    await lock.close();
    await rm(lockPath);
  }
}
