import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { transform } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "packages/agenticworld");
// Copy only release assets, never configs, signer keys, caches, or demo services.
for (const [source, destination] of [
  ["dist/mcp", "runtime/dist/mcp"], ["dist/sdk", "runtime/dist/sdk"],
  ["portal/dist", "runtime/portal/dist"],
  ["mcp/creation-page.html", "runtime/mcp/creation-page.html"],
  ["mcp/owner-action-page.html", "runtime/mcp/owner-action-page.html"],
  ["signer/AgenticSigner.swift", "runtime/signer/AgenticSigner.swift"],
  ["signer/prebuilt", "runtime/signer/prebuilt"],
  [".agents/skills/agentic-world", "skills/codex"],
  [".claude/skills/agentic-world", "skills/claude"],
]) {
  await mkdir(resolve(output, destination, ".."), { recursive: true });
  await cp(resolve(root, source), resolve(output, destination), { recursive: true });
}
for (const [source, destination] of [
  ["scripts/build-signer.ts", "runtime/scripts/build-signer.mjs"],
  ["scripts/init-mcp-config.ts", "runtime/dist/scripts/init-mcp-config.js"],
]) {
  const { code } = await transform(await readFile(resolve(root, source), "utf8"), { loader: "ts", format: "esm", target: "node22" });
  await mkdir(resolve(output, destination, ".."), { recursive: true });
  await writeFile(resolve(output, destination), code);
}
console.log("Installer package assembled (MCP, portal, native signer sources/binaries, skills). No native key was created.");
