# Mock payment processor (demo only)

A separate Worker named `mock-payment-processor`. It owns its own SQLite Durable
Object (`ProcessorState`, binding `PROCESSOR_STATE`, singleton `demo-processor`)
and durable webhook outbox. It has **no merchant D1 binding** and never posts money
or mutates merchant records. Public demo credentials below are not real secrets.

## Local startup

For the complete demo, follow the [root setup instructions](../README.md#setup).
From the repository root:

```sh
npm run db:setup   # stop dev first; preserves existing data
npm run dev
```

Vite starts both Workers. The merchant's `PAYMENT_PROCESSOR` binding targets
`mock-payment-processor`, and the processor's `MERCHANT` binding targets
`billing-assistant` for signed callbacks. No separate processor process or seed
command is needed. Both bindings are already configured.

For **standalone processor development only**, with the combined Vite server
stopped:

```sh
npx wrangler dev --config processor/wrangler.jsonc --persist-to processor/.wrangler/state --port 8790
```

This uses separate processor state. Without a separately running merchant,
callback deliveries retry and eventually remain `exhausted`; charge/status
endpoints still work. Do not run this alongside the combined Vite app or reset
merchant state while retaining old processor keys. See [safe isolated demos](../docs/local-testing.md#safe-setup-and-isolation).

Merchant requests use the service binding with `https://processor.internal` as
the origin. Direct standalone requests use `http://localhost:8790`. Both require:

```text
Authorization: Bearer demo-only-processor-token-not-a-secret
Content-Type: application/json  (for request bodies)
```

The processor config sets `PROCESSOR_TOKEN` to that public fixture and
`PROCESSOR_WEBHOOK_SECRET` to `demo-only-webhook-hmac-not-a-secret`. Use the latter
for merchant callback verification. Root and processor configurations already
contain their corresponding demo bindings and credentials.

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

| Method/path                                              | Contract                                                                                                                                                                   |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /charges`                                          | `ChargeRequest`; 201 on first committed outcome, 200 on replay; `ChargeResponse`.                                                                                          |
| `GET /charges/:processorPaymentId`                       | 200 `ChargeStatusResponse`.                                                                                                                                                |
| `GET /charges?idempotencyKey=<URL-encoded-original-key>` | Same status response by original key.                                                                                                                                      |
| `PUT /demo/scenarios`                                    | `{ invoiceId, scenarios: ProcessorScenario[] }`; replaces only the unconsumed per-invoice queue, maximum 20 entries, empty clears. Echoes input.                           |
| `GET /demo/inspect?invoiceId=<id>`                       | Read-only `{ invoiceId, keyRetention: "indefinite", scenarios, requests, outbox }`; latest 50 requests/100 events, newest first. No progression or delivery side effects.  |
| `POST /demo/deliver`                                     | `{ invoiceId, eventId }`; sends a `dropped` or `exhausted` event again, same event ID/body. Returns `{ invoiceId, eventId, state: "queued" }`; 409 for any other delivery. |

Additional demo controls (also require the bearer token):

| Method/path            | Contract                                                                                                                                                                                                                                                   |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /demo/decide`    | `{ invoiceId, processorPaymentId, outcome: ChargeState }`; moves a charge along the [state model](#state-model) and queues one new signed event. Returns `{ invoiceId, eventId, charge }`; 409 `invalid_transition` for a change the model does not allow. |
| `POST /demo/notify`    | `{ invoiceId, processorPaymentId }`; queues one new signed event (new event ID) for the charge's current state. Returns `{ invoiceId, eventId, charge }`.                                                                                                  |
| `POST /demo/reset`     | `{ invoiceId }`; destructively deletes that invoice's keys/charges, outbox and scenario queue, returns `{ invoiceId, reset: true }`. Other invoices are untouched.                                                                                         |
| `POST /demo/reset-all` | `{}`; destructively deletes every key/charge, outbox entry and scenario queue and cancels the delivery alarm, returns `{ reset: true }`. Used by the hosted demo's full reset.                                                                             |

Inspection is the processor's whole state for the invoice
(`ProcessorInspection` in `src/payments/protocol.ts`). Request entries contain
`{ request, scenario, charge, state, resolveAt, actions }`; `charge` is null and
`state` is `uncommitted` for an outage before commit. Outbox entries contain
`{ event, state, attempts, copiesRemaining, dueAt, deliveredAt, lastError,
actions }`. `actions` are the demo controls the state model allows. Numeric
times are epoch milliseconds; event `createdAt` is ISO UTC. Reset is a
separate, destructive exception that forgets the invoice's processor records
entirely.

## State model

`processor/model.ts` is the whole mock processor in three tables. The
processor never reads merchant data; what a change means for the invoice is the
merchant's decision.

- **Scenario plans** (`SCENARIO_PLANS`): how each queued scenario creates its
  charge. That covers its first state, whether the processor decides a pending
  charge itself after 2 seconds, an outage before commit, a lost response, and
  whether the charge's first webhook is dropped or sent twice.
- **Charge transitions** (`CHARGE_TRANSITIONS`): the only changes a committed
  charge can make, whoever makes them (the 2-second pending alarm or
  `/demo/decide`). Each change sends one new signed webhook.

  | From                            | To                                          |
  | ------------------------------- | ------------------------------------------- |
  | `pending`                       | `succeeded`, `soft_decline`, `hard_decline` |
  | `soft_decline` / `hard_decline` | `succeeded` (late success, same payment ID) |
  | `succeeded`                     | nothing                                     |

- **Deliveries**: `queued` events are sent by the alarm until `delivered` or,
  after 8 failed attempts, `exhausted`. `dropped` (lost-webhook scenario) and
  `exhausted` events can be delivered again with `/demo/deliver`.
  `/demo/notify` adds a new event for any committed charge.

Errors are `{ error: { code, message } }`. Important statuses: 400 invalid input,
401 unauthenticated, 404 unknown charge/endpoint, 409 `idempotency_conflict` or
`attempt_conflict`, 413 body over 16 KiB, 415 non-JSON, 503 outage, 504 simulated
lost response. **404/503/504 are not declines or permission to allocate a new key.**

The key payload is compared canonically, ignoring JSON property order but not
identity, amount, currency or method version. Different valid payloads under a
key get 409, including before an outage commits. Unsupported currencies/invalid
payloads get 400 and cannot mutate the original. A given attempt ID also cannot
be reused with a different key. Successful replay returns the current outcome
of the original charge, which changes only along the state model.

**Retention is indefinite during normal operation:** there is no automatic key
expiration or TTL. Changing scenario queues never affects existing keys. Persist
merchant attempts before sending them, and do not grant new-attempt budgets
based on this API.

**Reset is the explicit demo-only retention exception.** Once `/demo/reset`
deletes an invoice's keys, replaying an old key can create a fresh charge. For
the combined app, use **Admin → Debug → Reset to unpaid**, not a standalone
processor reset: the merchant terminates the old Workflow, clears processor
state first, then resets its own payment records while preserving credits.
This is not a refund or production recovery operation. An already-in-flight
webhook is not fenced by reset; wait for active work and deliveries to settle.
See [reset boundaries](../docs/payment-workflow.md#deliberate-boundaries).

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
| `unresolved_pending`            | Stays pending across restarts until `/demo/decide` decides it. That queues a normal signed event; the merchant is never force-edited.                                             |
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
This verifies processor transport in isolation. The implemented full merchant-D1 /
PaymentWorkflow integration matrix is `tests/payment-integration.test.mjs`; see
[local testing](../docs/local-testing.md#automated-verification-no-ai).
