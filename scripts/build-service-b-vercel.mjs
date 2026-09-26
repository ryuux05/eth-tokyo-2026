import { build } from "esbuild";
import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "demo-service-b/.vercel/output");
const staticDir = join(output, "static"), functionDir = join(output, "functions/api/service.func");
await Promise.all([mkdir(staticDir, { recursive: true }), mkdir(functionDir, { recursive: true })]);
await Promise.all([
  build({ absWorkingDir: root, entryPoints: ["demo-service-b/app.ts", "demo-service-b/styles.css"],
    bundle: true, platform: "browser", format: "esm", outdir: staticDir }),
  build({ absWorkingDir: root, entryPoints: ["demo-service-b/api.ts"], bundle: true,
    platform: "node", target: "node24", format: "esm", outfile: join(functionDir, "index.mjs") }),
  copyFile(join(root, "demo-service-b/index.html"), join(staticDir, "index.html")),
]);
await writeFile(join(functionDir, ".vc-config.json"), JSON.stringify({
  runtime: "nodejs24.x", handler: "index.mjs", launcherType: "Nodejs", maxDuration: 60,
}));
await writeFile(join(output, "config.json"), JSON.stringify({ version: 3, routes: [
  ...["health", "activity", "owner/status", "owner/challenge", "owner/register", "owner/workspace", "owner/permissions", "agent/lookup", "private/report"].map(path =>
    ({ src: `/${path}`, dest: `/api/service?__service_b_path=${encodeURIComponent(`/${path}`)}` })),
  { src: "/", dest: "/index.html" },
  { handle: "filesystem" },
] }, null, 2));
console.log("Service B Vercel output ready: demo-service-b/.vercel/output");
