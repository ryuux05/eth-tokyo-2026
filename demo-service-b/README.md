# Service B · Read and write permissions

**Live demo:** [Open Service B](https://eth-tokyo-2026-demo-service-b.vercel.app/).
For the separate enrollment/resource-permission demo, [open Service A](https://eth-tokyo-2026-demo-service-78xzh6jkd-ryuux05s-projects.vercel.app/).

Register your owner wallet once. With the Agentic World skill and MCP installed,
tell your agent: **“Go to https://eth-tokyo-2026-demo-service-b.vercel.app/ and get my report.”**

The homepage contains an ordinary `/private/report` link, visible without JavaScript.
The agent follows it; the SDK returns the Agentic World 401 offer, then a challenge
when the agent identifies itself. The agent signs locally and retries the same
resource. The SDK verifies its proof, resolves its onchain owner, checks that
owner's registration and returns the report with a short-lived session.

No copied protocol prompt, manual agent enrollment, separate agent-challenge route,
payment, or contract deployment is needed. Missing identity or owner registration
still requires the user to complete that setup; the agent must not bypass it.

## Permission demo

Sign in with the owner wallet once (a one-hour HttpOnly browser session; no gas).
The private text is masked by default, with an owner-only Show text control.
An authenticated agent appears automatically in that owner's panel. Read starts
enabled and Write starts disabled. Toggle either checkbox to change that agent's
service permissions; no onchain policy or wallet transaction changes.

- Read: `GET /private/report` returns the owner's stored text.
- Write: `PUT /private/report` with JSON `{ "text": "Hello from my agent" }`
  updates it (1–2000 characters). The response only acknowledges the write.
- Every request checks the current permissions, including existing Agent-Sessions.
  Removing Read or Write takes effect on the next request, not after session expiry.
- Write does not imply Read. Agents with neither permission cannot access the text.

Ask naturally: **“Go to this website and update my report to ‘Hello from my agent’.”**
The owner page polls for updates. The plaintext and permissions are only available
through authenticated routes; stars are a display choice, not the access control.
The resource API is discoverable in the homepage's Resource API section.

## Vercel

Create a **separate Vercel project** from this repository:

- Root Directory: `demo-service-b`.
- Framework: **Next.js**.
- Node.js: **24.x**.
- Enable **Include source files outside of the Root Directory in the Build Step**.
- Keep the install/build commands from `vercel.json`; output directory is `.next`.
- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (read/write).
  The same database as Service C is supported; B uses a separate namespace.
- `AGENTIC_SEPOLIA_RPC_URL` is optional; blank or absent uses the public Sepolia RPC.
- `SERVICE_B_ORIGIN` is optional for Vercel's generated deployment/production URLs.
  For a custom domain, set it to the exact HTTPS origin. Do not apply a production
  custom-domain value to previews. Owner registrations and sessions are origin-specific;
  use the stable production domain for the demo.
- Disable Vercel login protection for the public demo domain so agents can reach it.

The Next.js app renders the owner page and routes API calls through the same SDK
handler. No Hardhat, signer, browser wallet, or private key runs in the function.
The browser wallet signs only the registration message. RPC URLs/tokens stay server-side.
Add appropriate Vercel request-rate limits before broad public use.

After deployment, check `/health`, register the wallet, and ask your agent for the
report using only the site URL. A direct unauthenticated `/private/report` request
must return 401, not the report. Live activity shows successful agent access.

## Local

From the repository root:

```sh
npm run dev:demo-service-b
```

For the existing lightweight loopback adapter used by `npm run demo`, run
`npm run build:demo-service-b` then `npm run serve:demo-service-b`.

Local URL: `http://127.0.0.1:8797`. Only this loopback adapter uses memory, so local
registrations reset on restart. Hosted deployments require Redis and fail closed
without it. Challenges are consumed atomically; sessions are stored by token hash.

Build the hosted bundle without deploying:

```sh
npm run build:demo-service-b:vercel
```
