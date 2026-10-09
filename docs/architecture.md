# Architecture and billing design

For setup and the illustrated controls guide, see the [README](../README.md).

## Components

| Component      | Implementation                                                                   |
| -------------- | -------------------------------------------------------------------------------- |
| LLM            | Llama 3.3 70B on Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`)         |
| Chat input     | React + Vite UI, streamed over WebSockets via the Agents SDK                     |
| Memory / state | Chat history in each `BillingAssistant` agent's built-in SQLite (Durable Object) |
| Billing data   | One shared D1 database, the source of truth for every customer                   |
| Coordination   | InvoiceWorkflow + PaymentWorkflow; one chat agent per customer                   |
| Mock processor | Separate Worker with immutable idempotency keys and SQLite DO delivery outbox    |

```text
Browser ── WebSocket ──> BillingAssistant agent (one per customer) ── tools ──┐
   │                        └─ Llama 3.3 on Workers AI                      │
   └──── /api/* ──> Worker ── creates ──> InvoiceWorkflow                   ├─> D1 (billing)
                                            open → finalize → reconcile ──┘
                                                      └─> PaymentWorkflow ──> mock processor
                                                            │                      │
                                                            └─> D1 <─ signed webhook
```

**The AI never calculates or moves money.** Pricing, invoicing and the ledger
are ordinary tested code in [`src/billing/`](../src/billing/). The assistant
reads billing data through tools and proposes credits, which a person must
approve.

## AI guardrails

- **Customer-scoped tools** ([`assistant-tools.ts`](../src/assistant-tools.ts)).
  Each customer has their own agent instance, and its tools only query that
  customer's data. Read tools cover account overview, invoice details, monthly
  usage, month-over-month comparison, daily usage with spike detection, and
  payment state/timeline. Customer selection is scoping, not authentication.
- **No arithmetic by the model.** Comparisons, percentages, medians and
  per-meter charges are computed in [`reports.ts`](../src/billing/reports.ts)
  and returned already formatted.
- **Credits need human approval.** `issueCredit` has `needsApproval: true`;
  the UI shows an Approve/Reject card. The tool call ID is the credit's
  idempotency key, so a replayed approval cannot credit twice. The database
  atomically caps credits at total minus credits, posted payments and unresolved
  reservations. The assistant has no payment-mutation tool.
- **Deterministic edges.** A rejected credit gets a fixed reply without the
  model. After a failed credit, the credit tool is withheld for that turn so
  the model explains the error instead of retrying.

Workers AI streams Llama 3.3 output in two formats in each chunk, and
`workers-ai-provider` reads both. Without normalization, text appears twice and
tool-call arguments interleave into invalid JSON.
[`workers-ai.ts`](../src/workers-ai.ts) removes the duplicate before the
provider reads the stream.

## Invoice Workflow

[`invoice-workflow.ts`](../src/invoice-workflow.ts) checkpoints opening the draft
invoice (closing the month to new usage), finalization (price, lines and ledger
atomically), ledger reconciliation, and starting a separate payment collection
Workflow. Bad input (unknown customer, month not ended) fails immediately
instead of retrying. Every billing operation is idempotent, so a repeated step
is harmless.

Billing starts with a customer's first full month; there is no proration.
New UI invoice runs automatically collect. CLI-finalized invoices remain
available for configuring a payment scenario before collection.

## Payment collection

[`payment-workflow.md`](payment-workflow.md) contains the detailed design and
implementation/validation map. `PaymentWorkflow` persists immutable attempts
and reservations before contacting the mock processor. At most four new attempts
share a lifetime budget; transport retries reuse the same key/payload. Unknown
money remains reserved, even after the run ends in needs-review. Shared D1
reconciliation applies processor responses, lookups and signed webhooks once,
including late success after Workflow completion.

The customer view shows billing and payment status; the admin view exposes
collection, scenario queues, simulated card updates and explicit reconciliation
with opt-in bounded resume. Notices are local records, not emails.

## Billing data

Migrations:

- [Billing schema](../migrations/0001_billing_schema.sql)
- [Price catalog](../migrations/0002_price_catalog.sql)
- [Payments and cash ledger](../migrations/0003_payments.sql)
- [Demo payment reset](../migrations/0004_payment_debug_reset.sql)

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

### Invariants

- **Exact money.** Amounts are integer cents. Unit prices are integer
  micro-dollars, so sub-cent rates like $0.011 per 1,000 neurons are exact.
  Each invoice line is rounded half-up once, so lines add up to the total.
- **Idempotent usage.** Resending a usage event is a no-op; reusing its ID
  with different data is rejected as a conflict.
- **Two-step invoicing.** Opening a draft invoice closes the month to new
  usage. Finalizing prices the frozen usage and writes the lines, ledger entries
  and final status in one atomic `db.batch()`. Every write is guarded on the
  invoice still being a draft, so retries and concurrent runs finalize it
  exactly once. This maps directly onto Workflow steps.
- **Double-entry ledger.** Each invoice debits accounts receivable and credits
  revenue; each credit reverses part of that. Triggers make ordinary ledger
  entries immutable, and a unique (transaction, account) key prevents double
  posting. The explicit demo-only reset is a destructive exception; see
  [payment boundaries](payment-workflow.md#deliberate-boundaries).
- **Capped allocation.** SQL guards keep credits + posted payments + unresolved
  reservations at or below the invoice total, including concurrent mutations.
- **Reconciliation.** `reconcile()` reports unbalanced ledger transactions,
  invoices whose lines or ledger postings do not match their total, unposted
  credits, invalid payment/reservation postings and over-allocation. Payment
  reconciliation also compares original processor keys.

### Why D1

D1 keeps the project entirely on Cloudflare with no external database to host.
It cannot hold a transaction open while code runs, so each write is one statement
or one atomic batch, with SQL guards and unique constraints instead of locks.
A production billing system at scale would more likely use Postgres, which D1's
single-threaded design and 10 GB limit do not replace.

## Demo boundaries

Not implemented: real payment processing/refunds, proration for mid-month plan
changes, price changes over time, taxes, or currencies other than USD.

Billing/chat/payment-control APIs have no authentication. Chat credits require
approval; the local operator CLI also issues explicitly approved credits.
Processor bearer/HMAC credentials are public fixtures, not secrets. There is no
real money, card data or email. Do not expose dev or Explorer publicly.

Local state persists under `.wrangler/state/`; isolated demos use a separate
persistence directory. See [local testing](local-testing.md) for safe setup and
[observability](observability.md) for Explorer, logs and traces. Financial truth
remains D1, not logs.
