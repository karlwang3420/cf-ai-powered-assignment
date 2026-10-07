# Billing Assistant

An AI billing assistant for a usage-based cloud platform, built on Cloudflare.

Pick a customer, run monthly invoices through a Cloudflare Workflow, and ask
the assistant why a bill changed. It looks up the real billing data, explains
the charges, and can propose a credit that you approve or reject.

## Architecture

| Component      | Implementation                                                                     |
| -------------- | ---------------------------------------------------------------------------------- |
| LLM            | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)           |
| Chat input     | React + Vite UI, streamed over WebSockets via the Agents SDK                       |
| Memory / state | Chat history in each `BillingAssistant` agent's built-in SQLite (Durable Object)   |
| Billing data   | One shared D1 database, the source of truth for every customer                     |
| Coordination   | Cloudflare Workflow for invoice runs; one chat agent (Durable Object) per customer |

```
Browser ── WebSocket ──> BillingAssistant agent (one per customer) ── tools ──┐
   │                        └─ Llama 3.3 on Workers AI                          │
   └──── /api/* ──> Worker ── creates ──> InvoiceWorkflow                      ├─> D1 (billing)
                                            open → finalize → reconcile ───────┘
```

**The AI never calculates or moves money.** Pricing, invoicing, and the ledger
are ordinary tested code (`src/billing/`). The assistant only reads billing
data through tools and proposes credits, which a person must approve.

## How the AI is constrained

- **Customer-scoped tools** (`src/assistant-tools.ts`). Each customer has their
  own agent instance, and its tools only query that customer's data. Read
  tools: account overview, invoice details, monthly usage, month-over-month
  comparison, and daily usage with spike detection.
- **No arithmetic by the model.** Comparisons, percentages, medians, and
  per-meter charges are computed in code (`src/billing/reports.ts`) and
  returned already formatted.
- **Credits need human approval.** `issueCredit` has `needsApproval: true`;
  the UI shows an Approve/Reject card. The tool call id is the credit's
  idempotency key, so a replayed approval cannot credit twice, and the
  database caps credits at the invoice total.
- **Deterministic edges.** A rejected credit gets a fixed reply without the
  model. After a failed credit, the credit tool is withheld for that turn so
  the model explains the error instead of retrying.

## Invoice Workflow

`src/invoice-workflow.ts` runs three steps, each retried with backoff and
checkpointed: open the draft invoice (closing the month to new usage),
finalize it (price, write lines and ledger entries atomically), and reconcile
the ledger. Bad input (unknown customer, month not ended) fails immediately
instead of retrying. Because every billing operation is idempotent, a step
that runs twice is harmless.

Billing starts with a customer's first full month, since there is no
proration.

## Billing design

Schema: [`migrations/0001_billing_schema.sql`](migrations/0001_billing_schema.sql).
Prices: [`migrations/0002_price_catalog.sql`](migrations/0002_price_catalog.sql).

| Table                       | Purpose                                                              |
| --------------------------- | -------------------------------------------------------------------- |
| `plans`, `meters`           | Price plans (monthly fee) and what is metered (requests, AI neurons) |
| `price_tiers`               | Graduated prices per plan and meter, e.g. first 10M requests free    |
| `customers`                 | Customers and their plan                                             |
| `usage_events`              | Raw usage, keyed by the producer's idempotency key                   |
| `invoices`, `invoice_lines` | Monthly invoices and their line items                                |
| `credits`                   | Approved credits against finalized invoices                          |
| `ledger_entries`            | Append-only double-entry ledger                                      |

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
- **Capped credits.** A SQL guard keeps total credits on an invoice at or
  below its total, even under concurrent requests.
- **Reconciliation.** `reconcile()` reports unbalanced ledger transactions,
  invoices whose lines or ledger postings don't match their total, unposted
  credits, and over-credited invoices.

**Why D1:** it keeps the project entirely on Cloudflare with no external
database to host. D1 cannot hold a transaction open while code runs, so each
write is one statement or one atomic batch, with SQL guards and unique
constraints instead of locks. A production billing system at scale would more
likely use Postgres, which D1's single-threaded design and 10 GB limit don't
replace.

**Not implemented:** payments, proration for mid-month plan changes, price
changes over time, taxes, and currencies other than USD.

## Run locally

Requires Node.js 24+ and a Cloudflare account. Workers AI has no local
simulator, so local development calls Cloudflare remotely. D1 runs locally as
a SQLite file under `.wrangler/state/`.

```sh
npm install
npx wrangler login
npm run db:setup     # create the billing tables and load demo data
npm run dev
```

Open <http://localhost:5173>.

To test by hand (UI walkthrough, billing CLI, reconciliation), see
[`docs/local-testing.md`](docs/local-testing.md).

## Checks

```sh
npm run check   # formatting, lint, and type checking
npm test        # unit tests, plus billing tests against a real local D1
```

## Notes

- **Duplicate streaming output:** Workers AI streams Llama 3.3 output in two
  formats in each chunk, and `workers-ai-provider` reads both. Text appears
  twice and tool-call arguments interleave into invalid JSON.
  `src/workers-ai.ts` removes the duplicate before the provider reads the
  stream.
- **No authentication:** the API and chat are open, since this is a demo over
  seeded data. Credits can only be issued through an approved chat proposal.
- **Prompt history:** prompts are recorded in `PROMPTS.md` by a repo-local Pi
  extension; see `docs/prompt-history.md`.
- **Starter template:** this project is based on Cloudflare's
  [`agents-starter`](https://github.com/cloudflare/agents-starter) template
  (MIT license, see `LICENSE.agents-starter`).
