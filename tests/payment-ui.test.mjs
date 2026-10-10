import assert from "node:assert/strict";
import test from "node:test";
import { api } from "../src/client-api.ts";
import {
  canCollectPayment,
  canRetryPayment,
  needsNewerCard,
  paymentNeedsAttention,
  paymentNextStep,
  paymentPollDelay,
  pollPaymentRead
} from "../src/components/payment-state.ts";
import { createBillingTools } from "../src/assistant-tools.ts";
import {
  applyPaymentOutcome,
  claimCollection,
  preparePaymentAttempt
} from "../src/billing/payments.ts";
import { database, invoice } from "./helpers/d1.mjs";

const collection = {
  status: "open",
  attemptsRemaining: 4,
  balanceCents: 500,
  ownerActive: 0,
  hasConflict: 0,
  reservedCents: 0,
  needsAttention: 0
};

test("payment UI treats reservations and completed Workflow separately from financial state", () => {
  assert.equal(canCollectPayment(collection), true);
  for (const patch of [
    { ownerActive: 1 },
    { reservedCents: 500 },
    { hasConflict: 1 },
    { attemptsRemaining: 0 },
    { balanceCents: 0 },
    { status: "needs_review" },
    { status: "action_required" }
  ])
    assert.equal(canCollectPayment({ ...collection, ...patch }), false);
  const review = {
    ...collection,
    status: "needs_review",
    reservedCents: 500,
    ownerActive: 0
  };
  assert.equal(paymentNeedsAttention(review), true);
  assert.equal(paymentNeedsAttention(collection), false);
  assert.equal(paymentPollDelay([review]), 2000);
  assert.equal(
    paymentPollDelay([{ ...collection, status: "paid", balanceCents: 0 }]),
    10000,
    "late results still polled after completion"
  );
  assert.equal(
    paymentPollDelay([], [{}]),
    2000,
    "unapplied inbox keeps recovery visible"
  );
});

test("past-due guidance distinguishes a card timeout from exhausted attempts", () => {
  const timeout = {
    ...collection,
    status: "past_due",
    attemptsUsed: 1,
    attemptsRemaining: 3
  };
  assert.equal(
    paymentNextStep(timeout),
    "Past due · update card, then reconcile + resume"
  );
  assert.equal(
    paymentNextStep({ ...timeout, attemptsUsed: 4, attemptsRemaining: 0 }),
    "Automatic attempts used · retry manually"
  );
});

test("manual retry is offered only once the automatic attempts are used and nothing is in flight", () => {
  const exhausted = {
    ...collection,
    status: "past_due",
    attemptsUsed: 4,
    attemptsRemaining: 0,
    methodVersion: 1
  };
  assert.equal(canRetryPayment(exhausted), true);
  assert.equal(canCollectPayment(exhausted), false);
  for (const patch of [
    { attemptsRemaining: 1 },
    { ownerActive: 1 },
    { reservedCents: 500 },
    { hasConflict: 1 },
    { balanceCents: 0 }
  ])
    assert.equal(canRetryPayment({ ...exhausted, ...patch }), false);
  const hard = { attempts: [{ declineType: "hard", methodVersion: 1 }] };
  assert.equal(needsNewerCard(exhausted, hard), true);
  assert.equal(needsNewerCard({ ...exhausted, methodVersion: 2 }, hard), false);
});

test("payment polling fences stale customer success/errors and never overlaps reads", async (t) => {
  const resolvers = [];
  const values = [];
  const errors = [];
  let calls = 0;
  const stop = pollPaymentRead(
    () => {
      calls++;
      return new Promise((resolve, reject) =>
        resolvers.push({ resolve, reject })
      );
    },
    (value) => values.push(value),
    (error) => errors.push(error.message),
    () => 1
  );
  t.after(stop);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1);
  stop();
  resolvers[0].resolve("old customer");
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(values, []);
  assert.equal(calls, 1);
  let reject;
  const stopError = pollPaymentRead(
    () =>
      new Promise((_, r) => {
        reject = r;
      }),
    (v) => values.push(v),
    (e) => errors.push(e.message),
    () => 1
  );
  stopError();
  reject(new Error("old failure"));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(errors, []);
  const stopNew = pollPaymentRead(
    async () => "new customer",
    (v) => values.push(v),
    (e) => errors.push(e.message),
    () => 10000
  );
  t.after(stopNew);
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(values, ["new customer"]);
});

test("payment client encodes scopes, uses exact runtime contracts and surfaces errors", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const calls = [];
  globalThis.fetch = async (path, init) => {
    calls.push({
      path,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(init.body) : null
    });
    return Response.json({ ok: true });
  };
  await api.payments("customer /?");
  await api.paymentInbox("customer /?");
  await api.payment("invoice /?");
  await api.paymentRun("invoice /?");
  await api.collectPayment("invoice /?");
  await api.reconcilePayments("invoice /?", true);
  await api.updatePaymentMethod("customer /?", 2);
  await api.paymentScenarios("invoice /?", ["hard_decline", "success"]);
  assert.deepEqual(calls, [
    {
      path: "/api/payments?customerId=customer%20%2F%3F",
      method: "GET",
      body: null
    },
    {
      path: "/api/payments/inbox?customerId=customer%20%2F%3F",
      method: "GET",
      body: null
    },
    { path: "/api/payments/invoice%20%2F%3F", method: "GET", body: null },
    { path: "/api/payments/invoice%20%2F%3F/run", method: "GET", body: null },
    {
      path: "/api/payments/invoice%20%2F%3F/collect",
      method: "POST",
      body: null
    },
    {
      path: "/api/payments/reconcile",
      method: "POST",
      body: { invoiceId: "invoice /?", resume: true }
    },
    {
      path: "/api/payments/method",
      method: "POST",
      body: { customerId: "customer /?", expectedVersion: 2 }
    },
    {
      path: "/api/payments/invoice%20%2F%3F/scenarios",
      method: "PUT",
      body: { scenarios: ["hard_decline", "success"] }
    }
  ]);
  globalThis.fetch = async () =>
    Response.json(
      { error: { code: "conflict", message: "reservation retained" } },
      { status: 409 }
    );
  await assert.rejects(api.collectPayment("x"), /reservation retained/);
});

test("payment assistant is read-only, customer scoped, and uses reserved/paid creditable balance", async (t) => {
  const db = await database(t);
  const inv = await invoice(db, "cus_acme", "2026-09");
  const acme = createBillingTools(db, "cus_acme");
  const orbit = createBillingTools(db, "cus_orbit");
  const options = { toolCallId: "read-payment", messages: [] };
  const owner = await claimCollection(db, inv.id, 0);
  const { attempt } = await preparePaymentAttempt(db, owner);
  const read = await acme.getPaymentState.execute(
    { month: "2026-09" },
    options
  );
  assert.equal(read.reserved, "$11.76");
  assert.equal(read.paid, "$0.00");
  assert.equal(read.due, "$11.76");
  assert.equal(read.stillCreditable, "$0.00");
  assert.equal(read.attemptsUsed, 1);
  assert.ok(read.timeline.length > 0);
  assert.equal(read.attempts[0].idempotencyKey, attempt.idempotencyKey);
  assert.equal(
    (await acme.getInvoice.execute({ month: "2026-09" }, options))
      .stillCreditable,
    "$0.00"
  );
  assert.match(
    (await orbit.getPaymentState.execute({ month: "2026-09" }, options)).error,
    /unknown invoice/
  );
  assert.equal(acme.issueCredit.needsApproval, true);
  assert.deepEqual(
    Object.keys(acme).filter((name) =>
      /collect|reconcile|updatePayment|scenario|retry|decide|notify|deliver/i.test(
        name
      )
    ),
    []
  );
  await applyPaymentOutcome(db, {
    invoiceId: inv.id,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
    amountCents: attempt.amountCents,
    currency: "USD",
    methodVersion: attempt.methodVersion,
    processorPaymentId: "ui-test-payment",
    status: "succeeded"
  });
  const paid = await acme.getPaymentState.execute(
    { month: "2026-09" },
    options
  );
  assert.equal(paid.status, "paid");
  assert.equal(paid.paid, "$11.76");
  assert.equal(paid.reserved, "$0.00");
  assert.equal(
    (await acme.getInvoice.execute({ month: "2026-09" }, options))
      .stillCreditable,
    "$0.00"
  );
});
