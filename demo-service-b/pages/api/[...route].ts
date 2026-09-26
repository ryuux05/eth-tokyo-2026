import type { NextApiRequest, NextApiResponse } from "next";
import { createHostedServiceB } from "../../runtime.js";

export const config = { api: { bodyParser: false }, maxDuration: 60 };
const service = createHostedServiceB();
export default async function handler(request: NextApiRequest, response: NextApiResponse) {
  // Keep raw request bodies and the original resource path for the SDK middleware.
  request.url = (request.url ?? "/").replace(/^\/api\//, "/");
  await service(request, response);
}
