import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { waitForBrowserLauncher } from "../mcp/open-browser.js";

test("Windows browser handoff succeeds even if explorer later exits with code 1", async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(1), 10)"], { stdio: "ignore" });
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  await waitForBrowserLauncher(child, "win32");
  assert.equal(await exited, 1);
});

test("macOS browser opener still reports a nonzero exit", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(1)"], { stdio: "ignore" });
  await assert.rejects(waitForBrowserLauncher(child, "darwin"), /Could not open the default browser/);
});

test("browser launcher reports a failed spawn on Windows", async () => {
  const child = spawn("agentic-world-browser-launcher-does-not-exist", [], { stdio: "ignore" });
  await assert.rejects(waitForBrowserLauncher(child, "win32"), /ENOENT/);
});
