import type { IncomingMessage, ServerResponse } from "node:http";
import { createServiceBHandler } from "./server.js";
import { hostedServiceBStores, memoryServiceBStores } from "./stores.js";
import { createVerifiedSepoliaClient } from "../scripts/sepolia-runtime.js";
import { SEPOLIA_CHAIN_ID, SEPOLIA_DEPLOYMENT } from "../sdk/deployments.js";

/** Only deployment-controlled domains are trusted; arbitrary Host headers never set the audience. */
export function serviceBOrigin(environment: NodeJS.ProcessEnv, host?: string): string {
  const configured = environment.SERVICE_B_ORIGIN?.trim();
  if (!environment.VERCEL && !configured && ["127.0.0.1:8797", "localhost:8797"].includes(host ?? "")) return `http://${host}`;
  const origins = configured ? [configured] : [
    environment.VERCEL_URL && `https://${environment.VERCEL_URL}`,
    environment.VERCEL_ENV === "production" && environment.VERCEL_PROJECT_PRODUCTION_URL && `https://${environment.VERCEL_PROJECT_PRODUCTION_URL}`,
  ].filter((value): value is string => Boolean(value));
  if (!origins.length) throw new Error("Configure SERVICE_B_ORIGIN or Vercel deployment domains");
  const trusted = origins.map(value => {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error("SERVICE_B_ORIGIN must be a canonical HTTPS origin");
    return url;
  });
  const matched = host ? trusted.find(url => url.host === host) : trusted[0];
  if (!matched) throw new Error("Use the configured Service B domain");
  return matched.origin;
}

export function createHostedServiceB(environment: NodeJS.ProcessEnv = process.env) {
  const handlers = new Map<string, ReturnType<typeof createServiceBHandler>>();
  let client: ReturnType<typeof createVerifiedSepoliaClient> | undefined;
  return async (request: IncomingMessage, response: ServerResponse) => {
    let stage = "origin";
    try {
      const origin = serviceBOrigin(environment, request.headers.host);
      let handler = handlers.get(origin);
      if (!handler) {
        stage = "storage";
        const stores = !environment.VERCEL && origin.startsWith("http:") ? memoryServiceBStores() : hostedServiceBStores(origin, environment);
        stage = "rpc";
        client ??= createVerifiedSepoliaClient(environment.AGENTIC_SEPOLIA_RPC_URL?.trim() || "https://ethereum-sepolia-rpc.publicnode.com")
          .catch(error => { client = undefined; throw error; });
        handler = createServiceBHandler({ client: await client, chainId: SEPOLIA_CHAIN_ID,
          implementation: SEPOLIA_DEPLOYMENT.implementation, origin, audience: origin, stores });
        handlers.set(origin, handler);
      }
      stage = "request";
      await handler(request, response);
    } catch {
      const messages: Record<string, string> = {
        origin: "Use the configured Service B domain. Check SERVICE_B_ORIGIN if set.",
        storage: "Configure both Upstash REST environment variables, then redeploy Service B.",
        rpc: "Sepolia RPC or pinned deployment verification failed. Retry or set AGENTIC_SEPOLIA_RPC_URL.",
        request: "Service B temporarily unavailable. Check Redis and Sepolia RPC availability.",
      };
      // Deliberately omit provider errors: they may contain private URLs and credentials.
      console.error(`Service B failure: ${stage}`);
      if (!response.headersSent) response.writeHead(stage === "origin" ? 403 : 503,
        { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ error: messages[stage], code: `SERVICE_B_${stage.toUpperCase()}` }));
    }
  };
}
