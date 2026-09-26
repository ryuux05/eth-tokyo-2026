import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import type { Address, Hex, PublicClient } from "viem";
import { createServiceCHandler } from "./handler.js";
import { memoryStores, type ServiceCStores } from "./stores.js";

/** In-process HTTP adapter for tests. The actual UI and hosted API are Next.js. */
export async function startDemoServiceC(options: { client: PublicClient; chainId: number; implementation: Address;
  token?: Address; port?: number; stores?: ServiceCStores; audience?: string }) {
  const artifact = JSON.parse(await readFile(fileURLToPath(new URL(
    "../artifacts/contracts/demo/PolicyDemoService.sol/PolicyDemoService.json", import.meta.url)), "utf8")) as
    { bytecode: Hex; deployedBytecode: Hex };
  let handler: Awaited<ReturnType<typeof createServiceCHandler>> | undefined;
  const server = createServer((request, response) => {
    if (!handler) { response.writeHead(503).end(); return; }
    void handler(request, response).catch(() => { if (!response.headersSent) response.writeHead(503).end(); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Service C did not bind");
  const baseUrl = `http://127.0.0.1:${bound.port}`;
  const close = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  try {
    handler = await createServiceCHandler({ ...options, origin: baseUrl, audience: options.audience ?? "https://service-c.example",
      stores: options.stores ?? memoryStores(), artifact });
  } catch (error) { await close(); throw error; }
  return { baseUrl, close };
}
