import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const target = process.argv.includes("--windows") ? "win32" : process.platform;
const output = resolve(root, `dist/signer/agentic-signer${target === "win32" ? ".exe" : ""}`);

async function run(command: string, args: string[], cwd = root, env = process.env): Promise<void> {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", result => resolve(result ?? 1));
  });
  if (code !== 0) throw new Error(`${command} failed (${code})`);
}

await mkdir(resolve(root, "dist/signer"), { recursive: true });
if (target === "darwin") {
  const cache = await mkdtemp(join(tmpdir(), "agentic-world-swift-cache-"));
  try {
    // A fresh absolute module cache avoids Swift/Clang loading the same PCM via
    // differently cased macOS paths (for example Documents vs documents).
    await run("swiftc", ["-module-cache-path", cache, "-o", output, resolve(root, "signer/AgenticSigner.swift")]);
    await run(output, ["self-test"]);
  } finally {
    await rm(cache, { recursive: true, force: true });
  }
} else if (target === "win32") {
  const source = resolve(root, "signer/windows");
  await run("go", ["test", "./..."], source);
  const architecture = process.platform === "win32" && process.arch === "arm64" ? "arm64" : "amd64";
  await run("go", ["build", "-o", output, "."], source, { ...process.env, GOOS: "windows", GOARCH: architecture });
  if (process.platform === "win32") await run(output, ["self-test"]);
} else {
  throw new Error("Local P-256 signing currently supports macOS Secure Enclave or Windows TPM only");
}
