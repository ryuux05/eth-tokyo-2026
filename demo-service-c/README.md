# Service C · Compute-credit storefront

Register an owner wallet, choose a 1 or 2 USDC compute pack, and copy a prompt for
the agent to authenticate and check its own account policy. **Purchase checked—not paid.**
No USDC or compute credits are delivered. The API has no wallet key and never broadcasts payments.
WalletConnect/remote mobile pairing is not included; use a wallet-enabled browser.

Deploy or reuse the purchase contract once under **Service contract setup**. Policy
editing stays exclusively in the existing Agentic World portal. The storefront's
**Copy portal setup instructions** gives the exact target and USDC address: add an
ordered Token purchase ALLOW rule up to 1 USDC, then REQUIRE_OWNER_SIGNATURE up to
2 USDC. Other actions/amounts default to DENY. Review existing rules before saving.
Back in Service C, enter the agent address and read its policy. Change the limit in
the portal, confirm the transaction, then check again. Entering an agent here is
read-only inspection, not access registration.

## Local

From the repository root:

```sh
npm ci
npm run dev:demo-service-c
```

Open `http://127.0.0.1:8807`. For a production build, run `npm run build:demo-service-c`
then `npm run serve:demo-service-c`. `npm run demo` builds and starts A, B and this
Next.js app together. This uses Sepolia; it does not launch Hardhat or generate keys.

## Vercel

Import the repository as a new Vercel project; no deployment has been created for you.

1. Select **Next.js**, with **Root Directory `demo-service-c`**.
2. Enable **Include source files outside of the Root Directory in the Build Step**.
   The app imports the shared SDK and compiled contract artifact from its parent.
3. Use Node.js **24.x**. The included `vercel.json` runs `npm ci` in the monorepo
   root, compiles contracts, builds this workspace and uses its `.next` output.
4. Add private environment variables:
   - `SERVICE_C_ORIGIN`: canonical HTTPS origin, e.g. `https://policy.example.com`.
   - `AGENTIC_SEPOLIA_RPC_URL`: your Sepolia HTTPS RPC.
   - `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`: Redis REST credentials.
     Existing `KV_REST_API_URL` / `KV_REST_API_TOKEN` names are also supported.
5. Deploy. Connect a wallet on Sepolia. Purchase-contract deployment requires wallet
   confirmation and testnet gas. Owner registration is a message signature, not a transaction.

Set `SERVICE_C_ORIGIN` only for the intended environment/domain. For preview
deployments, omit it to use Vercel's deployment-specific `VERCEL_URL`; configure
Redis for previews too. Browser and agent requests must use the configured origin,
including its hostname. HTTPS origins become the signed authentication audience.
No incoming Host or Origin header is used to choose the trusted audience.

Hosted mode requires Redis and fails closed without it. Challenges and hashed
sessions have TTLs; `GETDEL` consumes each challenge atomically across function
instances. Activity retains the latest 40 checks for one hour. Only local loopback
runs may use in-memory stores. Session tokens are not persisted in plaintext.
Use Vercel firewall/rate limits and appropriate RPC/Redis quotas before sharing a
public deployment; the public preview reads chain state and uses those providers.

## API and limits

`GET /private/quote?target=0xTARGET&amount=1` keeps the same resource-first SDK flow:
401 AgenticWorld offer → Agent-ID challenge → proof headers → quote + Agent-Session.
No separate agent challenge/session endpoints are required. The human registers their
wallet by signing a one-time, origin-bound message. Verified agents resolve their
onchain owner through the SDK and may read a quote only if that owner is registered;
individual agents are not allowlisted. This grants quote access, never spending authority.
Owner registrations use shared Redis in hosted mode and memory locally. The page's **Copy prompt for agent** uses the deployed origin
and audience automatically, and its history shows browser and authenticated-agent checks.
The contract read is public and independent of service access. The page summarizes
the account's stored rules, not a service-defined limit. The purchase prompt asks
the agent to independently call `agentic_policy_check` on the quoted action.
Policy setup instructions open the existing portal; the storefront has no policy editor.

The suggested portal policy is an ordered pair: <=1 ALLOW, then <=2 REQUIRE_OWNER_SIGNATURE.
Saving in the portal replaces the entire existing policy. It grants no token allowance. The token
is Sepolia USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238`, with six decimals.
The threshold is per operation, not a cumulative budget or USD price oracle.

HTTP 200 means a policy quote was returned, not that a payment is approved or sent.
`evaluateAction()` does not prove balances, allowances, gas or valid authentication.
The local `npm run test:service-c` suite separately checks real EntryPoint execution,
P-256 signatures, owner approval/replay, policy updates, and shared-store behavior.
Existing Sepolia pins are unchanged and still require the previously documented
account deployment correction before funded execution. Do not fund an agent for
this preview.
