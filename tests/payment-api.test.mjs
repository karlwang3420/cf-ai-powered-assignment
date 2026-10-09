import assert from "node:assert/strict";
import test from "node:test";
import { handleApi } from "../src/api.ts";
import { chargePayload } from "../src/payments/service.ts";
import {
  DEMO_WEBHOOK_SECRET,
  signProcessorWebhook
} from "../src/payments/protocol.ts";
import {
  applyPaymentWebhook,
  claimCollection,
  getPaymentCollection,
  listPaymentInbox,
  markPaymentUncertain,
  preparePaymentAttempt,
  receivePaymentWebhook,
  releaseCollection
} from "../src/billing/payments.ts";
import { database, invoice } from "./helpers/d1.mjs";

async function setup(t) {
  const DB = await database(t);
  const inv = await invoice(DB, "cus_acme", "2026-09");
  const owner = await claimCollection(DB, inv.id, 0);
  const { attempt } = await preparePaymentAttempt(DB, owner);
  const outcome = {
    ...chargePayload(attempt),
    processorPaymentId: "processor-payment",
    status: "succeeded"
  };
  const events = [];
  const env = {
    DB,
    PROCESSOR_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET,
    PROCESSOR_TOKEN: "test",
    INVOICE_WORKFLOW: {},
    PAYMENT_WORKFLOW: {
      async get() {
        return {
          async sendEvent(event) {
            events.push(event);
            throw new Error("ended workflow");
          }
        };
      }
    },
    PAYMENT_PROCESSOR: {
      async fetch(request) {
        if (request.method === "PUT")
          return Response.json(await request.json());
        return Response.json({ charge: outcome });
      }
    }
  };
  const call = async (method, path, body, headers = {}) => {
    const response = await handleApi(
      new Request(`https://merchant.test/api/payments${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body)
      }),
      env
    );
    return { status: response.status, data: await response.json() };
  };
  const event = {
    eventId: "event-1",
    type: "payment.updated",
    createdAt: new Date().toISOString(),
    charge: outcome
  };
  const send = async (value = event, bad = false) => {
    const raw = JSON.stringify(value);
    return call(
      "POST",
      "/webhook",
      raw,
      await signProcessorWebhook(raw, bad ? "wrong" : DEMO_WEBHOOK_SECRET)
    );
  };
  return { env, inv, owner, attempt, outcome, events, call, event, send };
}

test("payment inbox read requires one customer scope or explicit all, and omits applied and other-customer events", async (t) => {
  const { env, outcome, call } = await setup(t);
  await receivePaymentWebhook(env.DB, "acme-unapplied", outcome);
  await receivePaymentWebhook(env.DB, "acme-applied", outcome);
  await applyPaymentWebhook(env.DB, "acme-applied");
  const other = await invoice(env.DB, "cus_orbit", "2026-09");
  const owner = await claimCollection(env.DB, other.id, 0);
  const { attempt } = await preparePaymentAttempt(env.DB, owner);
  await receivePaymentWebhook(env.DB, "orbit-unapplied", {
    ...chargePayload(attempt),
    processorPaymentId: "orbit-payment",
    status: "pending"
  });
  const acme = await call("GET", "/inbox?customerId=cus_acme");
  assert.equal(acme.status, 200);
  assert.deepEqual(
    acme.data.map((e) => e.eventId),
    ["acme-unapplied"]
  );
  assert.deepEqual(
    (await call("GET", "/inbox?customerId=cus_orbit")).data.map(
      (e) => e.eventId
    ),
    ["orbit-unapplied"]
  );
  assert.deepEqual(
    (await call("GET", "/inbox?customerId=cus_nimbus")).data,
    []
  );
  for (const query of [
    "",
    "?customerId=",
    "?customerId=%20",
    "?customerId=cus_acme&customerId=cus_orbit",
    `?customerId=${"x".repeat(501)}`
  ]) {
    assert.equal((await call("GET", `/inbox${query}`)).status, 400);
  }
  assert.equal((await call("GET", "/inbox?customerId=missing")).status, 404);
  assert.deepEqual(
    (await call("GET", "/inbox?all=true")).data.map((e) => e.eventId),
    ["acme-unapplied", "orbit-unapplied"]
  );
  assert.equal(
    (await call("GET", "/inbox?all=true&customerId=cus_acme")).data.length,
    1,
    "an explicit customer scope still wins"
  );
});

test("payment API authenticates before receipt and validates full attempt identity", async (t) => {
  const { env, event, send } = await setup(t);
  assert.equal((await send(event, true)).status, 401);
  assert.equal(
    (await send({ ...event, charge: { ...event.charge, amountCents: 1 } }))
      .status,
    409
  );
  assert.equal((await send({ ...event, charge: null })).status, 400);
  assert.equal((await send({ ...event, type: "invalid" })).status, 400);
  assert.deepEqual(await listPaymentInbox(env.DB, false), []);
});

test("payment API durable application survives failed notification, duplicate and stale events", async (t) => {
  const { env, event, send, events, call, inv } = await setup(t);
  assert.deepEqual(await send(), {
    status: 202,
    data: { received: true, duplicate: false, applied: true }
  });
  assert.equal(events[0].type, "payment-attempt-1");
  assert.equal(events[0].payload.attemptId, event.charge.attemptId);
  assert.equal((await send()).data.duplicate, true);
  assert.equal((await send({ ...event, eventId: "event-2" })).status, 202);
  assert.equal(
    (
      await send({
        ...event,
        eventId: "event-stale",
        charge: { ...event.charge, status: "pending" }
      })
    ).status,
    202
  );
  assert.equal((await call("GET", `/${inv.id}`)).data.status, "paid");
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) n FROM payments").first()).n,
    1
  );
  assert.ok(
    (await listPaymentInbox(env.DB, false)).every(
      (e) => e.appliedAt !== null && e.notifiedAt === null
    )
  );
  assert.ok((await call("GET", `/${inv.id}/timeline`)).data.length > 0);
  assert.deepEqual((await call("GET", "?needsAttention=true")).data, []);
});

test("payment API durable receipt acknowledges failed financial application; explicit reconcile drains it", async (t) => {
  const { env, inv, send, call } = await setup(t);
  await env.DB.prepare(
    "CREATE TRIGGER inject_payment_failure BEFORE INSERT ON payments BEGIN SELECT RAISE(ABORT, 'test failure'); END"
  ).run();
  const receipt = await send();
  assert.equal(receipt.status, 202);
  assert.equal(receipt.data.applied, false);
  assert.equal((await listPaymentInbox(env.DB)).length, 1);
  assert.equal(
    (await getPaymentCollection(env.DB, inv.id)).reservedCents,
    inv.totalCents
  );
  await env.DB.prepare("DROP TRIGGER inject_payment_failure").run();
  const recovered = await call("POST", "/reconcile", { invoiceId: inv.id });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.data.inbox, [
    { eventId: "event-1", applied: true }
  ]);
  assert.deepEqual(recovered.data.issues, []);
  assert.equal((await getPaymentCollection(env.DB, inv.id)).status, "paid");
});

test("payment API late success after ended needs_review applies without Workflow; recovery also owns missing inbox application", async (t) => {
  const { env, inv, owner, attempt, outcome, call } = await setup(t);
  await markPaymentUncertain(env.DB, owner, attempt.id, "needs_review");
  await releaseCollection(env.DB, owner);
  await receivePaymentWebhook(env.DB, "crashed-after-inbox", outcome);
  assert.equal((await call("GET", "?needsAttention=true")).data.length, 1);
  const result = await call("POST", "/reconcile", {
    invoiceId: inv.id,
    resume: true
  });
  assert.equal(result.status, 200);
  assert.equal(result.data.runs[0].started, false);
  assert.equal((await getPaymentCollection(env.DB, inv.id)).status, "paid");
});

test("payment API method CAS, scenario forwarding, run status and invalid inputs", async (t) => {
  const { inv, call } = await setup(t);
  const body = { customerId: "cus_acme", expectedVersion: 1 };
  assert.equal((await call("POST", "/method", body)).data.methodVersion, 2);
  assert.equal((await call("POST", "/method", body)).data.methodVersion, 2);
  assert.equal(
    (await call("POST", "/method", { ...body, expectedVersion: 0 })).status,
    400
  );
  assert.deepEqual(
    (
      await call("PUT", `/${inv.id}/scenarios`, {
        scenarios: ["hard_decline", "success"]
      })
    ).data,
    { invoiceId: inv.id, scenarios: ["hard_decline", "success"] }
  );
  assert.equal(
    (await call("GET", `/${inv.id}/run`)).data.status,
    "unavailable"
  );
  assert.equal(
    (await call("POST", "/reconcile", { resume: "yes" })).status,
    400
  );
  assert.equal((await call("POST", "/reconcile", "null")).status, 400);
  assert.equal((await call("POST", "/unknown/path")).status, 404);
});

test("payment reconciliation reports pending as unresolved, not successful application; terminal/conflict precedence remains", async (t) => {
  const { env, inv, owner, attempt, outcome, call } = await setup(t);
  let charge = { ...outcome, status: "pending" };
  env.PAYMENT_PROCESSOR.fetch = async () => Response.json({ charge });
  await markPaymentUncertain(env.DB, owner, attempt.id, "needs_review");
  const pending = await call("POST", "/reconcile", { invoiceId: inv.id });
  assert.equal(pending.data.checks[0].result, "unresolved");
  assert.deepEqual(pending.data.issues, []);
  assert.equal(
    (await getPaymentCollection(env.DB, inv.id)).reservedCents,
    inv.totalCents
  );
  charge = { ...outcome, status: "declined", declineType: "soft" };
  assert.equal(
    (await call("POST", "/reconcile", { invoiceId: inv.id })).data.checks[0]
      .result,
    "applied"
  );
  assert.equal(
    (await call("POST", "/reconcile", { invoiceId: inv.id })).data.checks[0]
      .result,
    "duplicate"
  );
  assert.equal((await getPaymentCollection(env.DB, inv.id)).paidCents, 0);
  charge = outcome;
  assert.equal(
    (await call("POST", "/reconcile", { invoiceId: inv.id })).data.checks[0]
      .result,
    "conflict"
  );
});

test("payment attention API includes prepared reservations and removes them after confirmed success", async (t) => {
  const { inv, call, send } = await setup(t);
  const before = await call("GET", "?needsAttention=true");
  assert.equal(before.status, 200);
  assert.deepEqual(
    before.data.map((c) => c.invoiceId),
    [inv.id]
  );
  assert.equal(before.data[0].status, "processing");
  assert.equal(before.data[0].needsAttention, 1);
  assert.equal(before.data[0].reservedCents, inv.totalCents);
  assert.equal((await send()).data.applied, true);
  assert.deepEqual((await call("GET", "?needsAttention=true")).data, []);
  assert.equal((await call("GET", `/${inv.id}`)).data.needsAttention, 0);
});

test("debug reset clears one invoice's payment history atomically, processor first, and keeps others immutable", async (t) => {
  const { env, inv, outcome, call, send } = await setup(t);
  // A second customer's paid invoice must be untouched by the reset.
  const other = await invoice(env.DB, "cus_orbit", "2026-09");
  const otherOwner = await claimCollection(env.DB, other.id, 0);
  const { attempt: otherAttempt } = await preparePaymentAttempt(
    env.DB,
    otherOwner
  );
  await receivePaymentWebhook(env.DB, "orbit-paid", {
    ...chargePayload(otherAttempt),
    processorPaymentId: "orbit-payment",
    status: "succeeded"
  });
  await applyPaymentWebhook(env.DB, "orbit-paid");
  assert.equal((await send()).status, 202);
  const ar = async (customer) =>
    (
      await env.DB.prepare(
        "SELECT COALESCE(SUM(amount_cents), 0) AS v FROM ledger_entries WHERE customer_id = ? AND account = 'accounts_receivable'"
      )
        .bind(customer)
        .first()
    ).v;
  const arBefore = await ar("cus_acme");
  assert.equal((await getPaymentCollection(env.DB, inv.id)).status, "paid");

  const resets = [];
  let processorFails = true;
  env.PAYMENT_PROCESSOR.fetch = async (request) => {
    if (new URL(request.url).pathname === "/demo/reset") {
      resets.push(await request.json());
      return processorFails
        ? Response.json({ error: {} }, { status: 503 })
        : Response.json({ reset: true });
    }
    return Response.json({ charge: outcome });
  };
  const failed = await call("POST", `/${inv.id}/debug-reset`);
  assert.equal(failed.status, 409);
  assert.equal((await getPaymentCollection(env.DB, inv.id)).status, "paid");

  processorFails = false;
  const reset = await call("POST", `/${inv.id}/debug-reset`);
  assert.equal(reset.status, 200);
  assert.deepEqual(resets.at(-1), { invoiceId: inv.id });
  assert.equal(reset.data.status, "open");
  assert.equal(reset.data.paidCents, 0);
  assert.equal(reset.data.reservedCents, 0);
  assert.equal(reset.data.attemptsUsed, 0);
  assert.equal(reset.data.generation, 2);
  assert.equal(reset.data.attempts.length, 0);
  assert.deepEqual(
    reset.data.timeline.map((e) => e.kind),
    ["open", "debug_reset"]
  );
  assert.equal(
    (await ar("cus_acme")) - arBefore,
    outcome.amountCents,
    "payment posting removed, receivable restored"
  );
  const cash = await env.DB.prepare(
    "SELECT customer_id AS c, SUM(amount_cents) AS v FROM ledger_entries WHERE account = 'cash' GROUP BY customer_id"
  ).all();
  assert.deepEqual(cash.results, [
    { c: "cus_orbit", v: otherAttempt.amountCents }
  ]);
  assert.deepEqual(
    (await listPaymentInbox(env.DB, false)).map((e) => e.eventId),
    ["orbit-paid"]
  );
  assert.equal((await getPaymentCollection(env.DB, other.id)).status, "paid");
  // The unlock is gone: history is immutable again for every invoice.
  for (const sql of [
    "DELETE FROM payments",
    "DELETE FROM payment_attempts",
    "DELETE FROM payment_timeline",
    "DELETE FROM payment_webhook_inbox",
    "DELETE FROM ledger_entries WHERE account = 'cash'"
  ])
    await assert.rejects(env.DB.prepare(sql).run(), /immutable/);
  // Another invoice reaching the same generation can also be reset.
  const orbitReset = await call("POST", `/${other.id}/debug-reset`);
  assert.equal(orbitReset.status, 200);
  assert.equal(orbitReset.data.generation, reset.data.generation);
  assert.equal(orbitReset.data.status, "open");
  // A fresh campaign starts again at attempt 1 with the full budget.
  const owner = await claimCollection(env.DB, inv.id, reset.data.generation);
  const { attempt } = await preparePaymentAttempt(env.DB, owner);
  assert.equal(attempt.attemptNumber, 1);
  assert.equal(
    (await getPaymentCollection(env.DB, inv.id)).attemptsRemaining,
    3
  );
});
