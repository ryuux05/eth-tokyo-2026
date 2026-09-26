import { runBundlerConfiguration } from "../mcp/bundler-config.js";

try { await runBundlerConfiguration(); }
catch (error) {
  // Low-level filesystem errors can contain config contents or sensitive paths.
  const message = error instanceof Error && !("code" in error) ? error.message : "Could not save bundler configuration; check local file access";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
