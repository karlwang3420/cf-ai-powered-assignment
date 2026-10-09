# Local payment observability

Verified with Node 24.18.0, Vite 8.1.5, `@cloudflare/vite-plugin` **1.50.0**,
Wrangler **4.118.0**, plugin Miniflare **5.20260730.0-alpha**, and workerd
**1.20260730.1**. These are installed/pinned tools, not a claim about all
Cloudflare versions. Standalone store/CLI tests still use Miniflare 4.20260721.0.

## Explorer

Open <http://localhost:5173/cdn-cgi/local/explorer> while Vite is running.
`/cdn-cgi/explorer` is a supported alias on this version. Both are real Local
Explorer routes, not the application's SPA fallback. The billing panel links
to the canonical route. Inspect `payment-workflow` and `invoice-workflow`,
instances/checkpoints, D1, processor DOs, and **Observability**.

The integration test checks the actual Explorer page title **and** queries the
local trace store for recorded payment correlation logs and spans attributed to
both Workers. This proves runtime data exists, not just that documentation or
a navigation tab mentions tracing. Logs also print as structured JSON in the
Vite terminal. Local tracing is enabled by the installed plugin's
`X_LOCAL_OBSERVABILITY` default; explicitly setting it false disables these
queries. Root Wrangler observability is enabled, but no deployment or hosted
trace validation was performed.

The read-only local query endpoint is:

```text
POST /cdn-cgi/local/explorer/api/local/observability/query
Content-Type: application/json
{"sql":"SELECT service, name, outcome, trace_id FROM spans LIMIT 20"}
```

Response is `{ success, errors, messages, result: { columns, rows } }`.
Example correlation query (replace the invoice ID; no secrets required):

```sh
curl http://localhost:5173/cdn-cgi/local/explorer/api/local/observability/query \
  -H 'content-type: application/json' \
  -d '{"sql":"SELECT ts_ms, level, message, trace_id FROM logs WHERE message LIKE ? ORDER BY ts_ms DESC LIMIT 30","params":["%inv_cus_acme_2026-09%"]}'
```

`logs.message` is a JSON console-argument array containing the structured
payment log. Use its `trace_id` to query `spans`. Span attributes are SQLite
JSONB; select `json(attributes)` to read them. The endpoint only accepts a
single read-only SELECT/WITH, with a 10,000-row cap. Other Explorer resource
endpoints **can mutate** data, so keep Explorer on loopback. Its D1 raw-query
“batch” currently runs statements separately; it is not financial transaction
tooling and must not be used to emulate application `db.batch()`.

## Correlation and durable truth

Payment events such as `processor_charge`, `payment_reconciled`,
`payment_collection_started` and `payment_collection_finished` carry available
`invoiceId`, `workflowInstanceId`, `attemptId`, `processorPaymentId`, plus safe
status/result/check fields. Credentials, signatures and raw webhook bodies
are not logged. Processor outbox event IDs correlate with durable merchant
receipt; application and Workflow notification are separate states.

In the admin view (`/admin`), open an invoice and use its **Debug** tab to
inspect ordered attempts, stable keys, generation/owner/run and method versions;
**Activity** shows durable notices.
The timeline remains in merchant D1 even when terminal logs rotate or a Workflow
ends. **Needs attention** includes unresolved reservations, action-required,
positive past-due/conflicts, and actual unapplied merchant inbox events.

Financial state, not telemetry, answers whether money was posted:

- Workflow `complete` can mean needs-review or past-due, not paid.
- A successfully applied pending observation is reported as an **unresolved**
  processor check, even if internal ledger issues are empty.
- Applied/duplicate terminal checks can mean a confirmed **decline**, not just
  success; read the current financial status and attempt state.
- Late signed success can move needs-review to paid without changing the old
  Workflow's needs-review output.
- Use **Reconcile payments** or `billing reconcile-payments`, not raw SQL,
  force-release or a fresh key, to recover unresolved money.

Local traces/logs are developer diagnostics, not an authenticated audit export,
production retention guarantee, or proof of real payment processing.
