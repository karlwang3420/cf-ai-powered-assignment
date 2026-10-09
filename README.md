# Billing Assistant

An AI billing assistant for a usage-based cloud platform, built on Cloudflare
Workers AI, Agents, Workflows and D1. Explain invoices, investigate usage changes,
approve credits, and try payment-recovery scenarios. Billing math runs in code,
not the model; all payments are mocked and **no real money moves**.

**AI-assisted development:** [PROMPTS.md](PROMPTS.md) records the prompt history.

## How it meets the assignment

- **LLM:** Llama 3.3 on Workers AI explains bills using customer-scoped tools.
- **Workflow / coordination:** Cloudflare Workflows handle invoicing and payment
  retries, coordinating Workers and Durable Objects.
- **User input:** React chat streams messages over WebSockets through the Agents SDK.
- **Memory / state:** each customer's agent stores chat history in Durable Object
  SQLite; D1 persists billing, credits and payment records.

## Setup

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
billing CLI commands, especially on Windows.

**Local demo only:** there is no authentication. Keep the app and local Explorer
private. Payment controls need no AI calls; see [offline, isolated setup](docs/local-testing.md#safe-setup-and-isolation)
if you want to run without remote bindings.

## Quick manual

### 1. Check a customer's bill and ask the assistant

![Customer view with customer selector, expanded invoice, card update and chat input](docs/images/customer-billing.png)

- **Customer selector** switches the account and its separate chat history.
- **Invoice month** expands a Service / Total usage / Total cost table and approved
  credits. Usage tiers are combined per service; the plan fee stays separate. Paid, Processing
  and Due show where the balance stands; **Refresh** reloads billing data.
- **Chat** accepts a suggested question or your own message. Press **Enter** to
  send, **Shift+Enter** for a new line, or the stop button to stop generation.
- **Approve / Reject** appears when the assistant proposes a credit. Nothing is
  credited without approval; paid or reserved amounts cannot also be credited.
  Use an unpaid, uncollected invoice to try this.
- **Update card** simulates a new payment method—no card details are collected.
  The bug toggle shows chat debug data; **Clear chat** removes this account's
  conversation, not its billing records.

### 2. Run an invoice in Admin

![Admin view with invoice runner, collection filters and payment status table](docs/images/admin-invoices.png)

Switch to **Admin** (or open `/admin`). Choose a customer and an ended month,
then click **Run invoice**. The Workflow finalizes the invoice and automatically
starts mock payment collection; the default outcome is success.

Use **All statuses / Needs attention** and the customer filter to narrow the
collection table. Click an invoice row to open its payment controls.
**Reconcile all** checks collections and unapplied webhooks without requesting
new collection runs.

### 3. Try payment failures and recovery

![Invoice payment dialog showing Collect, reconciliation actions, mock scenario and simulated card update](docs/images/payment-controls.png)

To choose a scenario **before** collection, prepare an unpaid invoice with dev
stopped. For example, on a fresh demo database:

```sh
npm run billing -- invoice cus_acme 2026-09
npm run dev
```

CLI finalization does not start collection. Replaying it does not undo an
already-paid invoice; see [isolated demo setup](docs/local-testing.md#safe-setup-and-isolation)
for a fresh sandbox.

1. Open the invoice in **Admin → Mock controls** and choose a scenario. It
   applies immediately to future attempts, not past ones.
2. Click **Collect**. For **Hard decline → success**, click **Simulate card
   update** while the Workflow waits for a newer card.
3. **Reconcile** checks original processor keys and unapplied webhooks.
   **Reconcile + resume** also permits a new collection run and may charge the
   remaining mock balance. Neither bypasses the four-attempt limit.

**Held** means the processor result is unresolved, not failed. With the
unresolved-pending scenario, **Settle pending charge** appears in Mock controls
so you can send a late success or decline. See the [payment walkthrough](docs/local-testing.md#payment-walkthrough)
for timing, retry limits and more scenarios.

### 4. Inspect what happened

![Debug tab showing a hard decline followed by a successful payment after a card update](docs/images/payment-debug.png)

**Activity** shows the durable event timeline. **Debug** shows Workflow status,
attempts, idempotency keys and processor IDs, with a link to **Workflow Explorer**.
Check the money totals—not just Workflow completion—to confirm payment.

**Reset to unpaid** is destructive demo tooling: after confirmation it clears
that invoice's payment history and reopens collection; credits stay. Use it only
when deliberately restarting a demo scenario.

## Checks

```sh
npm run check
node --test --test-concurrency=2 tests/*.test.mjs
npx vite build
```

The bounded test command avoids a previously observed local-runtime stall with
unrestricted `npm test`; see [validation notes](docs/local-testing.md#automated-verification-no-ai).

## More documentation

- [Architecture and billing design](docs/architecture.md) — components, AI guardrails, exact money and ledger invariants.
- [Local testing and CLI](docs/local-testing.md) — isolated demos, recovery scenarios and verification.
- [Payment Workflow](docs/payment-workflow.md) — payment design and implementation map.
- [Observability](docs/observability.md) — local Explorer, logs, traces and correlation queries.
- [Mock processor](processor/README.md) — processor protocol and standalone development.
- [Prompt history](docs/prompt-history.md) — how [PROMPTS.md](PROMPTS.md) is recorded.

Based on Cloudflare's [agents-starter](https://github.com/cloudflare/agents-starter)
([MIT license](LICENSE.agents-starter)).
