# Deploying the hosted demo

The hosted demo runs on `workers.dev` behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/).
Reviewers sign in with a one-time PIN sent to their email; nothing is installed
on their machine. Everyone who signs in shares one copy of the data.

## How it works

- **Access in front, verified in the Worker.** Access blocks anyone who is not
  allowed before the Worker runs. The Worker also verifies the
  `Cf-Access-Jwt-Assertion` token on every API and chat request
  ([`src/demo/gate.ts`](../src/demo/gate.ts)), so a missing or misconfigured
  Access application fails closed. A Worker deployed without the Access
  settings answers API requests only on `localhost`. The processor's signed
  callback is the only exception, and only over the service binding.
- **Same-site only.** Chat connections from another site are refused, so a
  page a reviewer visits cannot use their Access session to chat
  ([`src/origin.ts`](../src/origin.ts)); API mutations have the same check.
- **Fresh data for each reviewer.** A singleton `DemoSession` Durable Object
  sees every request. A new Access session reseeds the demo only when nobody
  has made a request for 15 minutes, so overlapping reviewers never wipe each
  other's work, and a returning session keeps its data. The UI polls while
  open, so an open tab counts as activity. **Reset demo** in the banner
  reseeds at any time, for everyone. The banner re-reads the status every 30
  seconds and when **Reset demo** is opened, so it warns when someone else is
  active and offers a reload after someone else resets.
- **What a reset clears.** It stops active payment runs, clears the mock
  processor (keys, deliveries, scenarios), rebuilds D1 from the bundled
  migrations and seed in one atomic batch, and deletes each customer's chat.
  Requests that arrive during a reset wait until it finishes, and if a reset
  fails partway, every request retries it until it completes. The processor
  finishes a webhook it is already sending before it clears its records.
  The first signed-in request after deploy seeds the empty database the same
  way.
  Requests and invoice runs already in progress are not stopped, so a
  **Reset demo** clicked while someone is working can be followed by a few of
  their writes. Automatic resets happen only after 15 idle minutes, when
  nothing is in progress.
- **Nothing else is public.** The mock processor has no `workers.dev` URL and is
  reachable only through the service binding; its demo credentials are public
  in this repository. Preview and version URLs are off for both Workers, since
  Access protects only the `workers.dev` hostname.

Chat messages use your account's Workers AI allowance.

## Steps

You need a Cloudflare account with Workers and Zero Trust (Access) enabled.

1. **Find the app's hostname.** It is
   `billing-assistant.<your-subdomain>.workers.dev`; the subdomain is shown on
   the **Workers & Pages** overview.
2. **Turn on one-time PIN login.** In **Zero Trust → Integrations → Identity
   providers**, add **One-time PIN**.
3. **Create the Access application.** In **Zero Trust → Access →
   Applications**, add a **self-hosted** application for the hostname above.
   Do not use the Worker's own **Access** tab: Worker-level Access rejects
   WebSocket upgrades, which the chat needs. Add an **Allow** policy, for
   example the email domain `cloudflare.com` plus your own email. In the
   application's cookie settings, set **SameSite attribute** to **Lax**, so
   the Access cookie is not sent with requests from other sites.
4. **Copy two values.** Your team domain (`<team>.cloudflareaccess.com`, under
   **Settings → Team name and domain**) and the application's **Application
   Audience (AUD) Tag**.
5. **Deploy.**

   ```sh
   npx wrangler login
   DEMO_ACCESS_TEAM_DOMAIN=<team>.cloudflareaccess.com \
   DEMO_ACCESS_AUD=<aud tag> npm run deploy:demo
   ```

   The script builds both Workers and deploys the processor, then the app with
   the Access settings. On the first deploy it puts the processor up once
   without its callback binding, because a service binding's target must
   already exist. Wrangler creates the D1 database on the first deploy.

6. **Check it.** Open the hostname in a private window: you should get the
   Access login page. After signing in, the app loads with the seeded
   customers and a "Shared demo" banner. Without signing in,
   `curl https://<hostname>/api/customers` should not return data.

To redeploy after changes, run step 5 again. To take the demo down, delete both
Workers (`billing-assistant`, `mock-payment-processor`), the `billing` D1
database and the Access application.
