import { spawn, type ChildProcess } from "node:child_process";

export class BrowserLaunchError extends Error {
  constructor() { super("Could not open the default browser"); }
}

export function waitForBrowserLauncher(child: ChildProcess, platform: NodeJS.Platform): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    if (platform === "win32") {
      // Explorer may return exit code 1 even after handing the URL to the browser.
      child.once("spawn", () => { child.unref(); resolve(); });
    } else {
      child.once("exit", code => code === 0 ? resolve() : reject(new Error("Could not open the default browser")));
    }
  });
}

export async function openDefaultBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : undefined;
  if (!command) throw new BrowserLaunchError();
  try { await waitForBrowserLauncher(spawn(command, [url], { stdio: "ignore" }), process.platform); }
  catch { throw new BrowserLaunchError(); }
}
