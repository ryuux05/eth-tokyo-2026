import type { NextApiRequest, NextApiResponse } from "next";
import { serviceCHandler } from "../../runtime.js";

export const config = { api: { bodyParser: false }, maxDuration: 30 };
export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  response.setHeader("Cache-Control", "no-store");
  try { await (await serviceCHandler())(request, response); }
  catch {
    // Configuration and provider errors must not expose private Redis/RPC URLs.
    if (!response.headersSent) response.status(503).json({ error: "Service C unavailable. Check server RPC, origin and shared-store configuration." });
  }
}
