import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import next from "next";
import { createVerifiedSepoliaClient, resolveSepoliaRpcUrl } from "./sepolia-runtime.js";

/** Local launcher only. Vercel uses Next.js pages/API routes directly, not a custom server. */
export async function startServiceCNext(options) {
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) throw new Error("Invalid Service C port");
  const baseUrl = `http://127.0.0.1:${options.port}`;
  process.env.SERVICE_C_ORIGIN = baseUrl;
  process.env.AGENTIC_SEPOLIA_RPC_URL = options.rpcUrl;
  const app = next({ dev: false, dir: fileURLToPath(new URL("../demo-service-c", import.meta.url)), hostname: "127.0.0.1", port: options.port });
  await app.prepare();
  const server = createServer(app.getRequestHandler());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject); server.listen(options.port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
    const health = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(30_000) });
    if (!health.ok) throw new Error("Service C startup check failed; check RPC and store configuration");
  } catch (error) {
    server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); await app.close(); throw error;
  }
  return { baseUrl, close: async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); await app.close();
  } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const rpcUrl = await resolveSepoliaRpcUrl();
  await createVerifiedSepoliaClient(rpcUrl);
  const service = await startServiceCNext({ rpcUrl, port: Number(process.env.AGENTIC_SERVICE_C_PORT ?? "8807") });
  process.stdout.write(`Service C (Next.js): ${service.baseUrl}\n`);
  process.once("SIGINT", () => void service.close()); process.once("SIGTERM", () => void service.close());
}
