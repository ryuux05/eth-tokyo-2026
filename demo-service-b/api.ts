import { createHostedServiceB } from "./runtime.js";
import type { IncomingMessage, ServerResponse } from "node:http";

const service = createHostedServiceB();
const paths = new Set(["/health", "/activity", "/owner/status", "/owner/challenge", "/owner/register", "/agent/lookup", "/private/report"]);

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  // Explicitly preserve the resource path across the platform's internal API rewrite.
  const url = new URL(request.url ?? "/", "https://routing.invalid");
  const routed = url.searchParams.get("__service_b_path");
  if (routed && paths.has(routed)) {
    url.searchParams.delete("__service_b_path");
    request.url = `${routed}${url.search}`;
  }
  await service(request, response);
}
