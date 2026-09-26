import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const packageWindows = process.argv.includes("--package-windows");
const verifyWindows = process.argv.includes("--verify-windows-bundle");
const target = packageWindows ? "win32" : process.platform;
const output = resolve(root, `dist/signer/agentic-signer${target === "win32" ? ".exe" : ""}`);
const bundleRoot = resolve(root, "signer/prebuilt");
type WindowsArch = "x64" | "arm64";
type BundleManifest = Record<WindowsArch, string>;

function bundledPath(architecture: WindowsArch): string {
  return resolve(bundleRoot, `win32-${architecture}/agentic-signer.exe`);
}

async function sha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function verifyBundledWindowsSigner(architecture: WindowsArch): Promise<string> {
  const manifest = JSON.parse(await readFile(resolve(bundleRoot, "manifest.json"), "utf8")) as Partial<BundleManifest>;
  const expected = manifest[architecture];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`Missing checksum for Windows ${architecture} signer`);
  const bundled = bundledPath(architecture);
  const bytes = await readFile(bundled);
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error(`Bundled Windows ${architecture} signer checksum mismatch`);
  if (bytes.length < 64 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("Bundled Windows signer is not a PE executable");
  const peOffset = bytes.readUInt32LE(0x3c);
  const machine = architecture === "x64" ? 0x8664 : 0xaa64;
  if (peOffset + 6 > bytes.length || bytes.toString("binary", peOffset, peOffset + 4) !== "PE\0\0" ||
      bytes.readUInt16LE(peOffset + 4) !== machine) throw new Error(`Bundled Windows ${architecture} signer has the wrong architecture`);
  return bundled;
}

async function run(command: string, args: string[], cwd = root, env = process.env): Promise<void> {
  const child = spawn(command, args, { cwd, env, stdio: "inherit" });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", result => resolve(result ?? 1));
  });
  if (code !== 0) throw new Error(`${command} failed (${code})`);
}

if (verifyWindows) {
  for (const architecture of ["x64", "arm64"] as const) await verifyBundledWindowsSigner(architecture);
  process.stdout.write("Bundled Windows x64 and ARM64 signers match their checksums and PE architectures.\n");
} else if (packageWindows) {
  const source = resolve(root, "signer/windows");
  await run("go", ["test", "./..."], source);
  const manifest = {} as BundleManifest;
  for (const architecture of ["x64", "arm64"] as const) {
    const destination = bundledPath(architecture);
    await mkdir(resolve(bundleRoot, `win32-${architecture}`), { recursive: true });
    await run("go", ["build", "-trimpath", "-buildvcs=false", "-o", destination, "."], source,
      { ...process.env, GOOS: "windows", GOARCH: architecture === "x64" ? "amd64" : "arm64", CGO_ENABLED: "0" });
    manifest[architecture] = await sha256(destination);
  }
  await writeFile(resolve(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const architecture of ["x64", "arm64"] as const) await verifyBundledWindowsSigner(architecture);
} else if (target === "darwin") {
  await mkdir(resolve(root, "dist/signer"), { recursive: true });
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
  await mkdir(resolve(root, "dist/signer"), { recursive: true });
  if (process.arch !== "x64" && process.arch !== "arm64") throw new Error(`Unsupported Windows architecture: ${process.arch}`);
  const architecture = process.arch as WindowsArch;
  const bundled = await verifyBundledWindowsSigner(architecture);
  await copyFile(bundled, output);
  if (await sha256(output) !== await sha256(bundled)) throw new Error("Installed Windows signer checksum mismatch");
  await run(output, ["self-test"]);
} else {
  throw new Error("Local P-256 signing currently supports macOS Secure Enclave or Windows TPM only");
}
