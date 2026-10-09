# Billing Assistant

An AI billing assistant for a usage-based cloud platform, built on Cloudflare.

Pick a customer, run monthly invoices through a Cloudflare Workflow, and ask
the assistant why a bill changed. It looks up the real billing data, explains
the charges, and can propose a credit that you approve or reject. Finalized
invoices also collect **mock payments** through a second Worker, with bounded
retries, card-update waits and late-webhook reconciliation. No real money moves.

## Architecture

| Component      | Implementation                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| LLM            | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)         |
| Chat input     | React + Vite UI, streamed over WebSockets via the Agents SDK                     |
| Memory / state | Chat history in each `BillingAssistant` agent's built-in SQLite (Durable Object) |
| Billing data   | One shared D1 database, the source of truth for every customer                   |
| Coordination   | InvoiceWorkflow + PaymentWorkflow; one chat agent per customer                   |
| Mock processor | Separate Worker with immutable idempotency keys and SQLite DO delivery outbox    |

```
Browser ── WebSocket ──> BillingAssistant agent (one per customer) ── tools ──┐
   │                        └─ Llama 3.3 on Workers AI                          │
   └──── /api/* ──> Worker ── creates ──> InvoiceWorkflow                      ├─> D1 (billing)
                                            open → finalize → reconcile ───────┘
                                                      └─> PaymentWorkflow ──> mock processor
                                                            │                      │
                                                            └─> D1 <─ signed webhook
```

**The AI never calculates or moves money.** Pricing, invoicing, and the ledger
are ordinary tested code (`src/billing/`). The assistant only reads billing
data through tools and proposes credits, which a person must approve.

## How the AI is constrained

- **Customer-scoped tools** (`src/assistant-tools.ts`). Each customer has their
  own agent instance, and its tools only query that customer's data. Read
  tools: account overview, invoice details, monthly usage, month-over-month
  comparison, daily usage with spike detection, and read-only payment state/timeline.
- **No arithmetic by the model.** Comparisons, percentages, medians, and
  per-meter charges are computed in code (`src/billing/reports.ts`) and
  returned already formatted.
- **Credits need human approval.** `issueCredit` has `needsApproval: true`;
  the UI shows an Approve/Reject card. The tool call id is the credit's
  idempotency key, so a replayed approval cannot credit twice, and the
  database atomically caps credits at total minus credits, posted payments and
  unresolved reservations. The assistant has no payment-mutation tool.
- **Deterministic edges.** A rejected credit gets a fixed reply without the
  model. After a failed credit, the credit tool is withheld for that turn so
  the model explains the error instead of retrying.

## Invoice Workflow

`src/invoice-workflow.ts` checkpoints opening the draft invoice (closing the
month to new usage), finalization (price, lines and ledger atomically), ledger
reconciliation, and starting a separate payment collection Workflow. Bad input (unknown customer, month not ended) fails immediately
instead of retrying. Because every billing operation is idempotent, a step
that runs twice is harmless.

Billing starts with a customer's first full month, since there is no
proration.

## Payment collection

[`docs/payment-workflow.md`](docs/payment-workflow.md) is the approved design
and implementation/validation map. `PaymentWorkflow` persists immutable attempts
and reservations before contacting the mock processor. At most four new attempts
share a lifetime budget; transport retries reuse the same key/payload. Unknown
money remains reserved, even after the run ends in needs-review. Shared D1
reconciliation applies processor responses, lookups and signed webhooks once,
including late success after Workflow completion.

The billing panel provides authoritative paid/reserved/due/creditable amounts,
needs-attention, durable timeline, scenario queues, simulated card updates and
explicit **Reconcile payments** (bounded resume is opt-in). Notices are local
records, not emails. New UI invoice runs automatically collect; CLI-finalized
invoices remain available for configuring a scenario before collection.

## Billing design

Schema: [`migrations/0001_billing_schema.sql`](migrations/0001_billing_schema.sql).
Prices: [`migrations/0002_price_catalog.sql`](migrations/0002_price_catalog.sql).
Payments/cash ledger upgrade: [`migrations/0003_payments.sql`](migrations/0003_payments.sql).

| Table                                                             | Purpose                                                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| `plans`, `meters`                                                 | Price plans (monthly fee) and what is metered (requests, AI neurons) |
| `price_tiers`                                                     | Graduated prices per plan and meter, e.g. first 10M requests free    |
| `customers`                                                       | Customers and their plan                                             |
| `usage_events`                                                    | Raw usage, keyed by the producer's idempotency key                   |
| `invoices`, `invoice_lines`                                       | Monthly invoices and their line items                                |
| `credits`                                                         | Approved credits against finalized invoices                          |
| `ledger_entries`                                                  | Append-only double-entry ledger, including cash/payment postings     |
| `payment_collections`, `payment_attempts`, `payment_reservations` | Ownership, lifetime attempt budget and unresolved money              |
| `payments`, `payment_webhook_inbox`, `payment_timeline`           | Posted payments, durable receipt/application and notices             |

- **Exact money.** Amounts are integer cents. Unit prices are integer
  micro-dollars, so sub-cent rates like $0.011 per 1,000 neurons are exact.
  Each invoice line is rounded half-up once, so lines add up to the total.
- **Idempotent usage.** Resending a usage event is a no-op; reusing its id
  with different data is rejected as a conflict.
- **Two-step invoicing.** Opening a draft invoice closes the month to new
  usage. Finalizing then prices the frozen usage and writes the lines, the
  ledger entries, and the final status in one atomic `db.batch()`. Every write
  is guarded on the invoice still being a draft, so retries and concurrent runs
  finalize it exactly once. This maps directly onto Workflow steps.
- **Double-entry ledger.** Each invoice debits accounts receivable and credits
  revenue; each credit reverses part of that. Triggers make entries immutable,
  and a unique (transaction, account) key prevents double posting.
- **Capped allocation.** SQL guards keep credits + posted payments + unresolved
  reservations at or below the invoice total, including concurrent mutations.
- **Reconciliation.** `reconcile()` reports unbalanced ledger transactions,
  invoices whose lines or ledger postings don't match their total, unposted
  credits, invalid payment/reservation postings and over-allocation. The local
  payment reconciliation action also compares original processor keys.

**Why D1:** it keeps the project entirely on Cloudflare with no external
database to host. D1 cannot hold a transaction open while code runs, so each
write is one statement or one atomic batch, with SQL guards and unique
constraints instead of locks. A production billing system at scale would more
likely use Postgres, which D1's single-threaded design and 10 GB limit don't
replace.

**Not implemented:** real payment processing/refunds, proration for mid-month
plan changes, price changes over time, taxes, or currencies other than USD.

## Run locally

Requires Node.js 24+. Chat needs a Cloudflare account because Workers AI has
no local simulator; payments/tests need no model calls. Local financial and
processor state persists under `.wrangler/state/`. Stop dev before migration
or legacy direct-file CLI writes (Windows SQLite locking). Preserve existing
demo data: setup applies migrations and seeds only an empty customer database.

```sh
npm install
npx wrangler login
npm run db:setup     # migrate without resetting; seed only if empty
npm run dev
```

Open <http://localhost:5173>.

To test by hand (UI walkthrough, billing CLI, reconciliation), see
[`docs/local-testing.md`](docs/local-testing.md).

## Checks

```sh
npm run check   # formatting, lint, and type checking
npm test        # fresh D1, browser fixtures and real two-Worker integration (~minutes)
node --test tests/payment-integration.test.mjs
npm run types
npx vite build
```

The final reviewed tree passed all **106 tests** with
`node --test --test-concurrency=2 tests/*.test.mjs`. One unrestricted `npm test`
run stalled in a local runtime test; its cause remains unproven. Use the bounded
command if you encounter this, and see [validation details](docs/local-testing.md#automated-verification-no-ai).

## Notes

- **Duplicate streaming output:** Workers AI streams Llama 3.3 output in two
  formats in each chunk, and `workers-ai-provider` reads both. Text appears
  twice and tool-call arguments interleave into invalid JSON.
  `src/workers-ai.ts` removes the duplicate before the provider reads the
  stream.
- **Demo only / no authentication:** billing/chat/payment-control APIs are open.
  Chat credits require approval; the local operator CLI also issues approved
  credits. Processor bearer/HMAC credentials are public fixtures, not secrets.
  No real money/card data/email; do not expose dev or Explorer publicly.
- **Local observability:** `/cdn-cgi/local/explorer` shows Workflows and local
  logs/traces on the pinned tooling. See [verified routes and correlation
  queries](docs/observability.md); financial truth remains D1, not logs.
- **Prompt history:** prompts are recorded in `PROMPTS.md` by a repo-local Pi
  extension; see `docs/prompt-history.md`.
- **Starter template:** this project is based on Cloudflare's
  [`agents-starter`](https://github.com/cloudflare/agents-starter) template
  (MIT license, see `LICENSE.agents-starter`).
