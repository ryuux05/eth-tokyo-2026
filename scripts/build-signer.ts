import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "dist/signer/agentic-signer");
const source = resolve(root, "signer/AgenticSigner.swift");

async function run(command: string, args: string[]): Promise<void> {
  const child = spawn(command, args, { cwd: root, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", result => resolve(result ?? 1));
  });
  if (code !== 0) throw new Error(`${command} failed (${code})`);
}

await mkdir(resolve(root, "dist/signer"), { recursive: true });
const cache = await mkdtemp(join(tmpdir(), "agentic-world-swift-cache-"));
try {
  // A fresh absolute module cache avoids Swift/Clang loading the same PCM via
  // differently cased macOS paths (for example Documents vs documents).
  await run("swiftc", ["-module-cache-path", cache, "-o", output, source]);
  await run(output, ["self-test"]);
} finally {
  await rm(cache, { recursive: true, force: true });
}
