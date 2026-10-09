# Mock payment processor (demo only)

A separate Worker named `mock-payment-processor`. It owns its own SQLite Durable
Object (`ProcessorState`, binding `PROCESSOR_STATE`, singleton `demo-processor`)
and durable webhook outbox. It has **no merchant D1 binding** and never posts money
or mutates merchant records. Public demo credentials below are not real secrets.

## Local startup / next-stage wiring

From the repository root, using the already installed dependencies:

```sh
npx wrangler dev --config processor/wrangler.jsonc --persist-to processor/.wrangler/state --port 8790
```

Start the merchant separately under its existing `billing-assistant` Worker name.
The processor config already binds `MERCHANT` to that service. Until it is running
and implements the callback, deliveries retry and eventually remain `exhausted`;
charge/status endpoints still work. Never delete/reset existing `.wrangler` data.

The runtime owner must add a merchant service binding, recommended name
`PAYMENT_PROCESSOR`, targeting `mock-payment-processor`. Requests through that
binding can use `https://processor.internal` as the origin. They require:

```text
Authorization: Bearer demo-only-processor-token-not-a-secret
Content-Type: application/json  (for request bodies)
```

The processor config sets `PROCESSOR_TOKEN` to that public fixture and
`PROCESSOR_WEBHOOK_SECRET` to `demo-only-webhook-hmac-not-a-secret`. Use the latter
for merchant callback verification. These names belong to processor config; no
root configs or packages have been changed.

## Wire contracts

Shared exports live in `src/payments/protocol.ts`:

- `ChargeRequest`: `{ invoiceId, attemptId, idempotencyKey, amountCents,
currency: "USD", methodVersion }`. Identifiers are nonempty, at most 200
  characters, without surrounding whitespace/control characters. Amount and
  method version are positive safe integers. Unknown fields are rejected.
- `ProcessorCharge`: that exact payload plus `processorPaymentId` and either
  `{ status: "pending" | "succeeded" }` or
  `{ status: "declined", declineType: "soft" | "hard" }`. Structurally compatible
  with merchant `PaymentOutcome`, including stable IDs for declines.
- `ChargeResponse`: `{ charge: ProcessorCharge, replayed: boolean }`.
- `ChargeStatusResponse`: `{ charge: ProcessorCharge }`.
- `ProcessorWebhook`: `{ eventId, type: "payment.updated", createdAt, charge }`.
- `ProcessorScenario`, `ProcessorErrorResponse`, demo credential/header/path
  constants, `isProcessorAuthorized`, `signProcessorWebhook`, and
  `verifyProcessorWebhook`.

### Endpoints (all require the bearer token)

| Method/path                                              | Contract                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /charges`                                          | `ChargeRequest`; 201 on first committed outcome, 200 on replay; `ChargeResponse`.                                                                                         |
| `GET /charges/:processorPaymentId`                       | 200 `ChargeStatusResponse`.                                                                                                                                               |
| `GET /charges?idempotencyKey=<URL-encoded-original-key>` | Same status response by original key.                                                                                                                                     |
| `PUT /demo/scenarios`                                    | `{ invoiceId, scenarios: ProcessorScenario[] }`; replaces only the unconsumed per-invoice queue, maximum 20 entries, empty clears. Echoes input.                          |
| `GET /demo/inspect?invoiceId=<id>`                       | Read-only `{ invoiceId, keyRetention: "indefinite", scenarios, requests, outbox }`; latest 50 requests/100 events, newest first. No progression or delivery side effects. |
| `POST /demo/outbox/retry`                                | `{ eventId }`; only an `exhausted` delivery can be explicitly resumed. Returns `{ eventId, state: "queued" }`; same event ID/body.                                        |

Inspection request entries contain `{ request, scenario, charge, resolveAt }`;
`charge` is null for an outage before commit. Outbox entries contain `{ event,
state, attempts, copiesRemaining, dueAt, deliveredAt, lastError }`. Numeric times
are epoch milliseconds; event `createdAt` is ISO UTC. No destructive reset or
terminal-outcome editing endpoint exists.

Errors are `{ error: { code, message } }`. Important statuses: 400 invalid input,
401 unauthenticated, 404 unknown charge/endpoint, 409 `idempotency_conflict` or
`attempt_conflict`, 413 body over 16 KiB, 415 non-JSON, 503 outage, 504 simulated
lost response. **404/503/504 are not declines or permission to allocate a new key.**

The key payload is compared canonically, ignoring JSON property order but not
identity, amount, currency or method version. Different valid payloads under a
key get 409, including before an outage commits. Unsupported currencies/invalid
payloads get 400 and cannot mutate the original. A given attempt ID also cannot
be reused with a different key. Successful replay returns the current outcome
of the original charge; pending may advance, terminal outcomes never change.

**Retention is indefinite in this demo:** no key expiration, purge, TTL or blind
key reuse is implemented. There is no expiration race for callers to guess at.
Changing scenario queues never affects existing keys. Persist merchant attempts
before sending them, and do not grant new-attempt budgets based on this API.

## Scenarios

Queues consume **one entry per new key**, not per HTTP retry. Default: `success`.
For example, `{"invoiceId":"inv_1","scenarios":["hard_decline","success"]}`
supports card-update recovery without changing old outcomes.

| Scenario                        | Deterministic behavior                                                                                                                                                            |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                       | Succeeded charge and signed event.                                                                                                                                                |
| `soft_decline` / `hard_decline` | Declined charge with subtype and signed event.                                                                                                                                    |
| `outage`                        | First POST durably pins payload/scenario, returns 503 before charge creation. Status is 503 until a same-key POST commits success. That replay does not consume another scenario. |
| `lost_response`                 | Atomically commits success + outbox, returns 504 **without charge data** once. Same-key replay or status returns the one committed charge.                                        |
| `pending`                       | Pending charge/event, then success/event after 2 seconds via durable alarm (or a due status/replay observation). Same payment ID, distinct event IDs.                             |
| `unresolved_pending`            | Pending forever, even after restarts; emits only its initial pending event. No unsafe force-success/decline control.                                                              |
| `lost_webhook`                  | Succeeded charge; its durable event is deliberately `dropped` and never sent. Status reconciliation still succeeds.                                                               |
| `duplicate_webhook`             | Succeeded charge; sends two copies of the **same** durable event/body. Ordinary delivery failure can also cause duplicates.                                                       |

Method versions are explicit in every request, response and event. This fake
processor does not store card tokens or maintain a separate mutable method
registry: the merchant's CAS method-version update is authoritative. Send the
new version on the **next new attempt**, never change an old request. A hard
scenario is a scripted decline, not a stored invalid-card flag; use a queue to
specify the next outcome. Merchant logic owns the newer-version requirement.

## Webhooks / durability

`MERCHANT.fetch()` sends `POST https://merchant.internal/api/payments/webhook`.
Only 2xx is an acknowledgment; redirects are not followed. Receiver requirements:

1. Read the exact raw body, then call
   `verifyProcessorWebhook(rawBody, request.headers, DEMO_WEBHOOK_SECRET)`.
2. Parse/validate the event envelope and complete charge identity. Match the
   charge against the merchant's persisted attempt before financial application.
3. Insert durable inbox by `eventId`, invoke shared reconciliation independently
   of Workflow lifetime, and acknowledge durable receipt. Resume unapplied
   duplicates; a Workflow notification is only a hint.

HMAC-SHA256 signs `${timestampSeconds}.${rawBody}`. Headers:
`x-processor-timestamp` (integer epoch seconds) and
`x-processor-signature: v1=<lowercase-hex>`. Verification tolerates at most 300
seconds in either direction. Every retry signs a **fresh delivery timestamp**;
`eventId`, `createdAt`, charge and raw body stay unchanged. Do not reject retries
because event `createdAt` is old. Signature freshness is not event deduplication:
the merchant must persist unique event IDs and independently deduplicate payment
IDs. A duplicate event inside the signature window is expected.

Charge creation/progression and event insertion use one SQLite transaction.
Before each mutation or alarm delivery, a durable alarm is armed. Pending due
rows and queued outbox rows determine the next alarm; no in-memory delivery
timer exists. Delivery uses a persisted 30-second lease, a 5-second callback
abort signal, a maximum of 16 events per alarm and 8 delivery attempts, with
1/2/4/8/16/32/60-second failure backoff. Crashes during callback or before marking
acknowledgment can redeliver the same event. A lease survives object eviction and
Worker restart. When attempts exhaust, the row remains inspectable; the explicit
retry endpoint rearms it after fixing the callback. Dropped demo events are not
silently retried. Delivery state never changes the financial charge outcome.

## Validation

```sh
node --test tests/processor*.test.mjs
npx tsc --noEmit
npx oxlint processor src/payments/protocol.ts
npx oxfmt --check processor src/payments/protocol.ts tests/processor*.test.mjs
```

Node tests use fresh `node:sqlite` databases and the importable `Processor` core.
The runtime test bundles the minimal Cloudflare shell with installed esbuild,
runs real Miniflare SQLite DO alarms and a verifying merchant service Worker,
and reopens **only its own OS-temp** persistence directory to test restart.
This is a processor transport integration test, not the later merchant-D1 /
PaymentWorkflow integration test required by the design.
