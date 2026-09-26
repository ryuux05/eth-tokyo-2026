import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Publishing source-only would leave npx users with a broken MCP. Fail closed.
for (const path of [
  "runtime/dist/mcp/server.js", "runtime/dist/scripts/init-mcp-config.js",
  "runtime/scripts/build-signer.mjs", "runtime/mcp/creation-page.html",
  "runtime/mcp/owner-action-page.html", "runtime/portal/dist/main.js",
  "runtime/portal/dist/styles.css", "runtime/portal/dist/index.html",
  "runtime/signer/AgenticSigner.swift", "runtime/signer/prebuilt/manifest.json",
  "runtime/signer/prebuilt/win32-x64/agentic-signer.exe",
  "runtime/signer/prebuilt/win32-arm64/agentic-signer.exe",
  "skills/codex/SKILL.md", "skills/claude/SKILL.md",
]) {
  try { await access(fileURLToPath(new URL(`../${path}`, import.meta.url))); }
  catch { throw new Error(`Missing ${path}. Run npm run build:installer from the repository root before packing.`); }
}
