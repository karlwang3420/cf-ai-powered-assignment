# Billing Assistant

An AI billing assistant for a usage-based cloud platform, built on Cloudflare
Workers AI, Agents, Workflows and D1. Explain invoices, investigate usage changes,
approve credits, and try payment-recovery scenarios. Billing math runs in code,
not the model.

**AI-assisted development:** [PROMPTS.md](PROMPTS.md) records the prompt history.

## How it meets the assignment

- **LLM:** Llama 3.3 on Workers AI explains bills using customer-scoped tools.
- **Workflow / coordination:** Cloudflare Workflows handle invoicing and payment
  retries, coordinating Workers and Durable Objects.
- **User input:** React chat streams messages over WebSockets through the Agents SDK.
- **Memory / state:** each customer's agent stores chat history in Durable Object
  SQLite; D1 persists billing, credits and payment records.

## Hosted demo

**Link:** <https://billing-assistant.karlwang3420.workers.dev>

The hosted demo needs no setup. To sign in:

1. Open the link. Cloudflare Access shows its login page.
2. Enter your **@cloudflare.com** email and click **Send login code**. Other
   addresses are not allowed and get no email, although the page still says one
   was sent.
3. Paste the one-time code from the email (it comes from
   `noreply@notify.cloudflare.com` and expires after 10 minutes).

The app opens with the seeded customers and a **Shared demo** banner. Follow the
[quick manual](#quick-manual) below to test it.

**The demo is shared.** Everyone who signs in sees and changes the same data.
It returns to the seed when someone new signs in after 15 minutes without
activity, so you normally start fresh; if someone else is using it, a banner
says so. **Reset demo** in the banner reseeds it at any time, for everyone.

To deploy your own copy, see [deploying the hosted demo](docs/deploy.md).

## Local setup

Requires **Node.js 24+** and a Cloudflare account for chat (Workers AI runs remotely).

```sh
npm install
npx wrangler login
npm run db:setup
npm run dev
```

Open <http://localhost:5173>. Vite starts both the app and mock payment processor.
`db:setup` applies migrations and seeds demo customers only when the database is
empty; it preserves existing data. Stop dev before running setup or direct-file
billing CLI commands, especially on Windows: the running dev server holds the
database files open.

To return everything to the seed (billing data, mock processor and chats),
click **Reset demo** in the banner, or run `npm run billing -- reset-demo`.
Both run inside the dev server, so it keeps running, and they leave the
database on the latest migrations.

**Local demo:** there is no authentication. Keep the app and local Explorer
private; without the hosted demo's Access settings, the API answers only on
`localhost`. Mutating APIs reject foreign browser origins; originless CLI requests
and HMAC-verified processor callbacks remain supported. This is not authentication.
Payment controls need no AI calls; see [offline, isolated setup](docs/local-testing.md#safe-setup-and-isolation)
if you want to run without remote bindings.

## Quick manual

Start with the five-minute check below; the sections after it explain each
screen. Seeded customers have usage for August and September 2026 but no
invoices yet, so begin in **Admin**.

### Five-minute check

1. **Invoice two months.** Open **Admin**, choose **Nimbus Labs**, and click
   **Run invoice** for August, then September. Expect **$200.00** and
   **$330.00**, each "finalized, not collected yet". Close the payment dialog
   that opens; nothing is charged yet.
2. **Ask about the change.** Switch to the customer view, choose **Nimbus
   Labs**, and send the suggested question _Why did my bill change from August
   2026 to September 2026?_ The answer should attribute the $130.00 increase to
   Workers AI overage ($126.00, from a spike on September 15–20) plus $4.00 of
   extra requests.
3. **Approve a credit.** Ask for a credit on the September invoice, for example
   _Please credit $20 on my September invoice for the outage._ Click
   **Approve**. September now shows a **−$20.00** credit.
4. **Recover a declined payment.** In **Admin**, click the Nimbus September row.
   On **Mock controls**, choose **Hard decline → success (update card)**, then
   click **Collect**. The status becomes **Waiting for a newer card**. Within
   30 seconds, click **Simulate card update**. Expect **Paid in full**, **Due
   $0.00** and 2 of 4 attempts used.
5. **See what happened.** The **Activity** tab lists the decline, the card
   update and the payment.

### 1. Check a customer's bill and ask the assistant

![Customer view with customer selector, expanded invoice, card update and chat input](docs/images/customer-billing.png)

- **Customer selector** switches the account and its separate chat history.
- **Invoice month** lists invoices run in Admin; until then the view says
  **No invoices yet** and shows only this month's usage so far. A month expands
  to a Service / Total usage / Total cost table and approved credits. Usage tiers
  are combined per service; the plan fee stays separate. Paid, Processing and
  Due show where the balance stands; **Refresh** reloads billing data.
- **Chat** accepts a suggested question or your own message. Press **Enter** to
  send, **Shift+Enter** for a new line, or the stop button to stop generation.
- **Approve / Reject** appears when you ask for a credit and the assistant
  proposes one. Nothing is credited without approval. Credits apply only to an
  invoiced month, and only to the part not yet paid or held for a charge, so ask
  before collecting.
- **Update card** simulates a new payment method—no card details are collected.
  The bug toggle shows chat debug data; **Clear chat** removes this account's
  conversation, not its billing records.

### 2. Run an invoice in Admin

![Admin view with invoice runner, collection filters and payment status table](docs/images/admin-invoices.png)

Switch to **Admin** (or open `/admin`). Choose a customer and an ended month,
then click **Run invoice**. The Workflow finalizes the invoice but charges
nothing yet: its payment dialog opens so you can pick a mock outcome first, then
click **Collect**. With no outcome chosen, the charge succeeds.

Use **All statuses / Needs attention** and the customer filter to narrow the
collection table. Click an invoice row to open its payment controls.
**Reconcile all** checks collections and unapplied webhooks without requesting
new collection runs.

### 3. Try payment failures and recovery

![Invoice payment dialog showing Collect, reconciliation actions, a mock scenario with its explanation, and simulated card update](docs/images/payment-controls.png)

1. Run an invoice (or open an uncollected one) and choose a scenario in **Mock
   controls**. The text under the list says what will happen and what to do.
   It applies immediately to future attempts, not past ones.
2. Click **Collect**. For **Hard decline → success**, click **Simulate card
   update** within 30 seconds, while the Workflow waits for a newer card. If
   you miss it, the invoice becomes **Past due**: update the card, then click
   **Reconcile + resume**.
3. **Reconcile** checks original processor keys and unapplied webhooks.
   **Reconcile + resume** also permits a new collection run and may charge the
   remaining mock balance. Neither goes past the four automatic attempts.
4. After four declines the invoice is past due and **Collect** becomes **Retry
   payment**: each click is one manual attempt, charged at once. Pick the next
   outcome in Mock controls first. A hard decline needs **Simulate card update**
   before retrying.

**Mock controls** also show the mock processor's side: its latest charge for
this invoice, with a button for each state that charge can still move to. Hover
a button to see what it does. A declined charge can still **Succeed** (a late
success, with no new charge), and each change sends the billing side a signed
webhook. **Held** means a processor result is unresolved, not failed.
The [payment walkthrough](docs/local-testing.md#payment-walkthrough) covers
every scenario, timing and retry limits; the
[processor state model](processor/README.md#state-model) covers webhook
delivery.

### 4. Inspect what happened

![Debug tab showing a hard decline followed by a successful payment after a card update](docs/images/payment-debug.png)

**Activity** shows the durable event timeline. **Debug** shows Workflow status,
attempts, idempotency keys and processor IDs. In local dev it also links to
**Workflow Explorer**, which the hosted demo does not have. Check the money totals—not
just Workflow completion—to confirm payment.

**Reset to unpaid** is destructive demo tooling: after confirmation it clears
that invoice's payment history and reopens collection; credits stay. Use it only
when deliberately restarting a demo scenario. On the hosted demo it changes the
invoice for everyone.

## Checks

```sh
npm run check
npm test
npx vite build
```

## More documentation

- [Deploying the hosted demo](docs/deploy.md) — Cloudflare Access, shared-demo resets and deploy steps.
- [Architecture and billing design](docs/architecture.md) — components, AI guardrails, exact money and ledger invariants.
- [Local testing and CLI](docs/local-testing.md) — isolated demos, recovery scenarios and verification.
- [Payment Workflow](docs/payment-workflow.md) — payment design and implementation map.
- [Observability](docs/observability.md) — local Explorer, logs, traces and correlation queries.
- [Mock processor](processor/README.md) — processor protocol and standalone development.
- [Prompt history](docs/prompt-history.md) — how [PROMPTS.md](PROMPTS.md) is recorded.

Based on Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter)
([MIT license](LICENSE.agents-starter)).
