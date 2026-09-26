# Service B · Get my report

Register your owner wallet once. With the Agentic World skill and MCP installed,
tell your agent: **“Go to https://YOUR-SERVICE-B-DOMAIN and get my report.”**

The homepage contains an ordinary `/private/report` link, visible without JavaScript.
The agent follows it; the SDK returns the Agentic World 401 offer, then a challenge
when the agent identifies itself. The agent signs locally and retries the same
resource. The SDK verifies its proof, resolves its onchain owner, checks that
owner's registration and returns the report with a short-lived session.

No copied protocol prompt, manual agent enrollment, separate agent-challenge route,
payment, or contract deployment is needed. Missing identity or owner registration
still requires the user to complete that setup; the agent must not bypass it.

## Vercel

Create a **separate Vercel project** from this repository:

- Root Directory: `demo-service-b`.
- Framework: **Other** (not Next.js).
- Node.js: **24.x**.
- Enable **Include source files outside of the Root Directory in the Build Step**.
- Keep the install/build commands from `vercel.json`; leave Output Directory override off.
- Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (read/write).
  The same database as Service C is supported; B uses a separate namespace.
- `AGENTIC_SEPOLIA_RPC_URL` is optional; blank or absent uses the public Sepolia RPC.
- `SERVICE_B_ORIGIN` is optional for Vercel's generated deployment/production URLs.
  For a custom domain, set it to the exact HTTPS origin. Do not apply a production
  custom-domain value to previews. Owner registrations and sessions are origin-specific;
  use the stable production domain for the demo.
- Disable Vercel login protection for the public demo domain so agents can reach it.

The build emits Vercel Build Output API v3: static HTML/CSS/JS plus a bundled Node
function. No Hardhat, signer, browser wallet, or private key runs in the function.
The browser wallet signs only the registration message. RPC URLs/tokens stay server-side.
Add appropriate Vercel request-rate limits before broad public use.

After deployment, check `/health`, register the wallet, and ask your agent for the
report using only the site URL. A direct unauthenticated `/private/report` request
must return 401, not the report. Live activity shows successful agent access.

## Local

From the repository root:

```sh
npm run build:demo-service-b
npm run serve:demo-service-b
```

Local URL: `http://127.0.0.1:8797`. Only this loopback adapter uses memory, so local
registrations reset on restart. Hosted deployments require Redis and fail closed
without it. Challenges are consumed atomically; sessions are stored by token hash.

Build the hosted bundle without deploying:

```sh
npm run build:demo-service-b:vercel
```
