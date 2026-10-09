import assert from "node:assert/strict";
import test from "node:test";
import { getCustomer, issueCredit, reconcile } from "../src/billing/store.ts";
import {
  applyPaymentOutcome,
  applyPaymentWebhook,
  claimCollection,
  finalizeCollection,
  getPaymentCollection,
  listPaymentCollections,
  listPaymentInbox,
  listUnresolvedPaymentAttempts,
  markPaymentUncertain,
  markPaymentWebhookNotified,
  preparePaymentAttempt,
  receivePaymentWebhook,
  recordCollectionNotice,
  releaseCollection,
  updatePaymentMethod
} from "../src/billing/payments.ts";
import { applyMigration, code, database, invoice, NOW } from "./helpers/d1.mjs";

const credit = (invoiceId, amountCents, id = "credit") => ({
  id,
  invoiceId,
  amountCents,
  reason: "service credit",
  approvedBy: "operator"
});
const outcome = (attempt, status = "succeeded", extra = {}) => ({
  invoiceId: attempt.invoiceId,
  attemptId: attempt.id,
  idempotencyKey: attempt.idempotencyKey,
  amountCents: attempt.amountCents,
  currency: attempt.currency,
  methodVersion: attempt.methodVersion,
  processorPaymentId: `processor:${attempt.id}`,
  status,
  ...extra
});
async function setup(t, customer = "cus_acme") {
  const db = await database(t);
  const { id } = await invoice(db, customer, "2026-09");
  const owner = await claimCollection(db, id, 0, NOW);
  return { db, id, owner };
}
async function prepare(db, owner) {
  const previous =
    (await getPaymentCollection(db, owner.invoiceId)).attempts.at(-1) ?? null;
  // Store-only fixtures explicitly complete the runtime gate at the fixed test time.
  if (previous?.state === "declined" && previous.declineType === "soft") {
    await recordCollectionNotice(
      db,
      owner,
      {
        id: `${previous.id}:test-retry`,
        attemptNumber: previous.attemptNumber,
        kind: "retry_scheduled",
        message: "Test retry gate completed",
        deadlineAt: NOW.toISOString()
      },
      NOW
    );
  }
  const result = await preparePaymentAttempt(db, owner, NOW, previous);
  assert.equal(result.kind, "attempt");
  return result.attempt;
}
async function cents(db, id) {
  return db
    .prepare("SELECT * FROM payment_balances WHERE invoice_id = ?")
    .bind(id)
    .first();
}

test("0003 preserves existing ledger IDs, credits, immutable triggers and indexes", async (t) => {
  const db = await database(t, { through: "0002_price_catalog.sql" });
  const { id } = await invoice(db, "cus_acme", "2026-09");
  await db
    .prepare(
      "INSERT INTO credits VALUES ('old-credit', ?, 'cus_acme', 1176, 'old', 'operator', ?)"
    )
    .bind(id, NOW.toISOString())
    .run();
  await db
    .prepare(`INSERT INTO ledger_entries (id, transaction_id, account, customer_id, amount_cents, description, created_at)
    VALUES (40, 'credit:old-credit', 'credits_issued', 'cus_acme', 1176, 'old', ?),
           (41, 'credit:old-credit', 'accounts_receivable', 'cus_acme', -1176, 'old', ?)`)
    .bind(NOW.toISOString(), NOW.toISOString())
    .run();
  const before = (
    await db.prepare("SELECT * FROM ledger_entries ORDER BY id").all()
  ).results;
  await applyMigration(db, "migrations/0003_payments.sql");
  assert.deepEqual(
    (await db.prepare("SELECT * FROM ledger_entries ORDER BY id").all())
      .results,
    before
  );
  assert.equal((await getPaymentCollection(db, id)).status, "settled");
  assert.equal((await getPaymentCollection(db, id)).methodVersion, 1);
  assert.deepEqual(await reconcile(db), []);
  await assert.rejects(
    db.prepare("UPDATE ledger_entries SET description = 'changed'").run(),
    /immutable/
  );
  await assert.rejects(
    db.prepare("DELETE FROM ledger_entries").run(),
    /immutable/
  );
  const indexes = (await db.prepare("PRAGMA index_list(ledger_entries)").all())
    .results;
  assert.ok(indexes.some((i) => i.name === "ledger_entries_by_customer"));
  assert.ok(indexes.some((i) => i.unique === 1));
});

test("reservation survives uncertainty/review; late webhook succeeds once across different event IDs", async (t) => {
  const { db, id, owner } = await setup(t);
  const a = await prepare(db, owner);
  assert.deepEqual(
    [a.amountCents, a.currency, a.methodVersion, a.attemptNumber],
    [1176, "USD", 1, 1]
  );
  for (const state of ["recovering", "needs_review"]) {
    await markPaymentUncertain(db, owner, a.id, state, NOW);
    await assert.rejects(issueCredit(db, credit(id, 1), NOW), code("conflict"));
    assert.equal((await prepare(db, owner)).idempotencyKey, a.idempotencyKey);
    assert.equal((await cents(db, id)).reserved_cents, 1176);
  }
  await releaseCollection(db, owner, NOW);
  const success = outcome(a);
  await receivePaymentWebhook(db, "event-1", success, NOW);
  assert.equal((await listPaymentInbox(db)).length, 1); // crash after receipt is recoverable
  assert.equal(
    (await applyPaymentWebhook(db, "event-1", NOW)).status,
    "applied"
  );
  assert.equal((await listPaymentInbox(db)).length, 0);
  await receivePaymentWebhook(db, "event-2", success, NOW);
  assert.equal(
    (await applyPaymentWebhook(db, "event-2", NOW)).status,
    "duplicate"
  );
  assert.equal(
    (await applyPaymentWebhook(db, "event-1", NOW)).status,
    "duplicate"
  );
  assert.equal(
    (await receivePaymentWebhook(db, "event-1", success, NOW)).status,
    "duplicate"
  );
  const c = await getPaymentCollection(db, id);
  assert.deepEqual(
    [c.status, c.paidCents, c.reservedCents, c.balanceCents, c.attemptsUsed],
    ["paid", 1176, 0, 0, 1]
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM payments").first()).n,
    1
  );
  const entries = (
    await db
      .prepare(
        "SELECT account, amount_cents FROM ledger_entries WHERE transaction_id LIKE 'payment:%' ORDER BY account"
      )
      .all()
  ).results;
  assert.deepEqual(entries, [
    { account: "accounts_receivable", amount_cents: -1176 },
    { account: "cash", amount_cents: 1176 }
  ]);
  await assert.rejects(issueCredit(db, credit(id, 1), NOW), code("conflict"));
  assert.equal((await getCustomer(db, "cus_acme")).balanceCents, 0);
  assert.deepEqual(await listUnresolvedPaymentAttempts(db), []);
  assert.equal((await listPaymentInbox(db, false))[0].notifiedAt, null);
  await markPaymentWebhookNotified(db, "event-1", NOW);
  assert.equal(
    (await listPaymentInbox(db, false))[0].notifiedAt,
    NOW.toISOString()
  );
  assert.deepEqual(await reconcile(db), []);
});

test("competing prepares and credits never overallocate; credit replay remains idempotent after payment", async (t) => {
  const { db, id, owner } = await setup(t);
  const firstCredit = credit(id, 100, "before");
  await issueCredit(db, firstCredit, NOW);
  const results = await Promise.allSettled([
    ...Array.from({ length: 5 }, () => preparePaymentAttempt(db, owner, NOW)),
    ...Array.from({ length: 5 }, (_, i) =>
      issueCredit(db, credit(id, 100, `race-${i}`), NOW)
    )
  ]);
  for (const result of results)
    if (result.status === "rejected")
      assert.ok(code("conflict")(result.reason));
  let c = await getPaymentCollection(db, id);
  assert.equal(c.attempts.length, 1);
  assert.equal(c.attemptsUsed, 1);
  assert.equal(c.creditedCents + c.reservedCents, c.totalCents);
  assert.equal(c.creditableCents, 0);
  await applyPaymentOutcome(db, outcome(c.attempts[0]), { now: NOW });
  assert.equal((await issueCredit(db, firstCredit, NOW)).status, "duplicate");
  await assert.rejects(
    issueCredit(db, credit(id, 1, "after"), NOW),
    code("conflict")
  );
  c = await getPaymentCollection(db, id);
  assert.equal(c.creditedCents + c.paidCents, c.totalCents);
  assert.deepEqual(await reconcile(db), []);
});

test("parallel credits without reservations retain the atomic cap", async (t) => {
  const { db, id } = await setup(t);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, (_, i) =>
      issueCredit(db, credit(id, 700, `credit-${i}`), NOW)
    )
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await getPaymentCollection(db, id)).creditableCents, 476);
  assert.deepEqual(await reconcile(db), []);
});

test("hard decline requires newer method and four-attempt budget survives restarts and duplicate updates", async (t) => {
  const { db, id, owner: original } = await setup(t);
  let owner = original;
  for (let n = 1; n <= 4; n++) {
    const a = await prepare(db, owner);
    assert.deepEqual([a.attemptNumber, a.methodVersion], [n, n]);
    await applyPaymentOutcome(
      db,
      outcome(a, "declined", { declineType: "hard" }),
      { now: NOW }
    );
    await applyPaymentOutcome(
      db,
      outcome(a, "declined", { declineType: "hard" }),
      { now: NOW }
    );
    assert.equal((await getPaymentCollection(db, id)).reservedCents, 0);
    assert.equal(
      (await preparePaymentAttempt(db, owner, NOW)).kind,
      n === 4 ? "budget_exhausted" : "reevaluate"
    );
    await releaseCollection(db, owner, NOW);
    owner = await claimCollection(db, id, owner.generation, NOW);
    assert.equal(
      (await preparePaymentAttempt(db, owner, NOW)).kind,
      n === 4 ? "budget_exhausted" : "reevaluate"
    );
    assert.equal(await updatePaymentMethod(db, "cus_acme", n), n + 1);
    assert.equal(await updatePaymentMethod(db, "cus_acme", n), n + 1);
  }
  const c = await finalizeCollection(db, owner, NOW);
  assert.deepEqual(
    [c.status, c.attemptsUsed, c.methodVersion, c.needsAttention],
    ["past_due", 4, 5, 1]
  );
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW)).kind,
    "budget_exhausted"
  );
  assert.deepEqual(await reconcile(db), []);
});

test("soft decline releases once; credits between attempts reduce immutable next payload", async (t) => {
  const { db, id, owner } = await setup(t);
  const a = await prepare(db, owner);
  await applyPaymentOutcome(
    db,
    outcome(a, "declined", { declineType: "soft" }),
    { now: NOW }
  );
  await issueCredit(db, credit(id, 500), NOW);
  const b = await prepare(db, owner);
  assert.deepEqual(
    [b.attemptNumber, b.amountCents, b.methodVersion],
    [2, 676, 1]
  );
  await applyPaymentOutcome(
    db,
    outcome(a, "declined", { declineType: "soft" }),
    { now: NOW }
  );
  assert.equal((await getPaymentCollection(db, id)).status, "processing");
  assert.equal((await getPaymentCollection(db, id)).reservedCents, 676);
  assert.notEqual(a.idempotencyKey, b.idempotencyKey);
  await assert.rejects(
    db
      .prepare("UPDATE payment_attempts SET amount_cents = 1 WHERE id = ?")
      .bind(b.id)
      .run(),
    /immutable/
  );
  await assert.rejects(
    db.prepare("DELETE FROM payment_attempts WHERE id = ?").bind(b.id).run(),
    /immutable/
  );
  await applyPaymentOutcome(db, outcome(b), { now: NOW });
  assert.deepEqual(await reconcile(db), []);
});

test("stale owners are fenced; restart recovers original payload without allocating a new key", async (t) => {
  const { db, id, owner } = await setup(t);
  const claims = await Promise.all(
    Array.from({ length: 4 }, () => claimCollection(db, id, 0, NOW))
  );
  for (const claim of claims) assert.deepEqual(claim, owner);
  const a = await prepare(db, owner);
  await releaseCollection(db, owner, NOW);
  const next = await claimCollection(db, id, 1, NOW);
  assert.equal(next.generation, 2);
  assert.notEqual(next.workflowId, owner.workflowId);
  assert.equal(await updatePaymentMethod(db, "cus_acme", 1), 2);
  assert.deepEqual(await prepare(db, next), a);
  for (const action of [
    () => preparePaymentAttempt(db, owner, NOW),
    () => finalizeCollection(db, owner, NOW),
    () => releaseCollection(db, owner, NOW),
    () => markPaymentUncertain(db, owner, a.id, "needs_review", NOW),
    () =>
      recordCollectionNotice(
        db,
        owner,
        {
          id: "stale",
          attemptNumber: 1,
          kind: "recovery_check",
          message: "stale"
        },
        NOW
      ),
    () => claimCollection(db, id, 0, NOW)
  ])
    await assert.rejects(action(), code("conflict"));
  assert.equal((await getPaymentCollection(db, id)).status, "processing");
  // Financial proof from the original attempt remains actionable by the shared reconciler.
  await applyPaymentOutcome(db, outcome(a), { now: NOW });
  assert.equal((await getPaymentCollection(db, id)).status, "paid");
  assert.deepEqual(await reconcile(db), []);
});

test("guarded finalization settles full credits during card wait and past_due; unresolved stays reserved", async (t) => {
  const { db, id, owner } = await setup(t);
  const a = await prepare(db, owner);
  assert.equal(
    (await finalizeCollection(db, owner, NOW)).status,
    "needs_review"
  );
  assert.equal((await getPaymentCollection(db, id)).reservedCents, 1176);
  await applyPaymentOutcome(
    db,
    outcome(a, "declined", { declineType: "hard" }),
    { now: NOW }
  );
  const notice = {
    id: "card-wait",
    attemptNumber: 1,
    kind: "card_update_requested",
    message: "Update card",
    deadlineAt: "2026-10-07T12:01:00Z"
  };
  const original = await recordCollectionNotice(db, owner, notice, NOW);
  const duplicate = await recordCollectionNotice(
    db,
    owner,
    { ...notice, deadlineAt: "2026-10-08T12:00:00Z" },
    NOW
  );
  assert.equal(duplicate.deadlineAt, original.deadlineAt);
  const anotherNotification = await recordCollectionNotice(
    db,
    owner,
    {
      ...notice,
      id: "duplicate-notification",
      deadlineAt: "2026-10-09T12:00:00Z"
    },
    NOW
  );
  assert.equal(anotherNotification.id, original.id);
  assert.equal(anotherNotification.deadlineAt, original.deadlineAt);
  await issueCredit(db, credit(id, 1176), NOW);
  assert.equal((await getPaymentCollection(db, id)).status, "settled");
  assert.equal((await finalizeCollection(db, owner, NOW)).status, "settled");
  assert.equal((await preparePaymentAttempt(db, owner, NOW)).kind, "settled");
  const { id: other } = await invoice(db, "cus_orbit", "2026-09");
  const otherOwner = await claimCollection(db, other, 0, NOW);
  const otherAttempt = await prepare(db, otherOwner);
  const otherDecline = outcome(otherAttempt, "declined", {
    declineType: "hard"
  });
  await applyPaymentOutcome(db, otherDecline, { now: NOW });
  assert.equal(
    (await finalizeCollection(db, otherOwner, NOW)).status,
    "past_due"
  );
  await applyPaymentOutcome(db, otherDecline, { now: NOW });
  assert.equal((await getPaymentCollection(db, other)).status, "past_due");
  await issueCredit(db, credit(other, 500, "settle-past-due"), NOW);
  assert.equal((await getPaymentCollection(db, other)).status, "settled");
  assert.equal(
    (await listPaymentCollections(db)).filter((c) => c.needsAttention).length,
    0
  );
  assert.deepEqual(await reconcile(db), []);
});

test("mismatched/foreign processor results and inbox payload reuse cannot mutate money", async (t) => {
  const { db, id, owner } = await setup(t);
  const a = await prepare(db, owner);
  const success = outcome(a);
  for (const patch of [
    { invoiceId: "foreign" },
    { attemptId: "foreign" },
    { idempotencyKey: "foreign" },
    { amountCents: 1175 },
    { methodVersion: 2 }
  ])
    await assert.rejects(
      applyPaymentOutcome(db, { ...success, ...patch }),
      code("conflict")
    );
  await assert.rejects(
    applyPaymentOutcome(db, { ...success, currency: "EUR" }),
    code("invalid")
  );
  await receivePaymentWebhook(db, "event", success, NOW);
  await assert.rejects(
    receivePaymentWebhook(db, "event", { ...success, amountCents: 10 }, NOW),
    code("conflict")
  );
  await assert.rejects(
    applyPaymentOutcome(
      db,
      { ...success, status: "pending" },
      { eventId: "event" }
    ),
    code("conflict")
  );
  assert.equal((await listPaymentInbox(db)).length, 1);
  assert.equal((await getPaymentCollection(db, id)).paidCents, 0);
  await applyPaymentOutcome(db, outcome(a, "pending"), { now: NOW });
  await assert.rejects(
    applyPaymentOutcome(db, { ...success, processorPaymentId: "replacement" }),
    code("conflict")
  );
  const { id: other } = await invoice(db, "cus_orbit", "2026-09");
  const b = await prepare(db, await claimCollection(db, other, 0, NOW));
  await assert.rejects(
    applyPaymentOutcome(
      db,
      outcome(b, "succeeded", {
        processorPaymentId: success.processorPaymentId
      })
    ),
    code("conflict")
  );
  await applyPaymentWebhook(db, "event", NOW);
  assert.equal((await getPaymentCollection(db, id)).paidCents, 1176);
  assert.equal((await getPaymentCollection(db, other)).paidCents, 0);
  assert.deepEqual(await reconcile(db), []);
});

test("terminal observations are monotonic; contradictions quarantine without undoing prior money", async (t) => {
  const { db, id, owner } = await setup(t);
  const a = await prepare(db, owner);
  await applyPaymentOutcome(db, outcome(a), { now: NOW });
  assert.equal(
    (await applyPaymentOutcome(db, outcome(a, "pending"), { now: NOW })).status,
    "duplicate"
  );
  assert.equal((await getPaymentCollection(db, id)).status, "paid");
  assert.equal((await finalizeCollection(db, owner, NOW)).status, "paid");
  await receivePaymentWebhook(
    db,
    "contradictory",
    outcome(a, "declined", { declineType: "soft" }),
    NOW
  );
  assert.equal(
    (await applyPaymentWebhook(db, "contradictory", NOW)).status,
    "conflict"
  );
  let c = await getPaymentCollection(db, id);
  assert.deepEqual(
    [
      c.status,
      c.paidCents,
      c.reservedCents,
      c.hasConflict,
      c.attempts[0].state
    ],
    ["needs_review", 1176, 0, 1, "succeeded"]
  );
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW)).kind,
    "needs_review"
  );
  assert.equal(
    (await finalizeCollection(db, owner, NOW)).status,
    "needs_review"
  );
  assert.equal(
    (await listPaymentInbox(db, false))[0].applicationResult,
    "conflict"
  );
  assert.deepEqual(
    (await reconcile(db)).map((i) => i.check),
    ["payment_outcome_conflict"]
  );

  const { id: other } = await invoice(db, "cus_orbit", "2026-09");
  const secondOwner = await claimCollection(db, other, 0, NOW);
  const b = await prepare(db, secondOwner);
  await applyPaymentOutcome(
    db,
    outcome(b, "declined", { declineType: "soft" }),
    { now: NOW }
  );
  const next = await prepare(db, secondOwner);
  assert.equal(
    (await applyPaymentOutcome(db, outcome(b), { now: NOW })).status,
    "conflict"
  );
  c = await getPaymentCollection(db, other);
  assert.deepEqual(
    [c.status, c.paidCents, c.reservedCents, c.attempts[0].state],
    ["needs_review", 0, 500, "declined"]
  );
  assert.equal(
    (await preparePaymentAttempt(db, secondOwner, NOW)).kind,
    "needs_review"
  );
  assert.equal(c.attempts[1].id, next.id);
});

test("concurrent same-payment successes and pending observations post once; batch failure rolls back all financial effects", async (t) => {
  const { db, id, owner } = await setup(t);
  const a = await prepare(db, owner);
  await db
    .prepare(
      "CREATE TRIGGER fail_payment_ledger BEFORE INSERT ON ledger_entries WHEN NEW.account = 'cash' BEGIN SELECT RAISE(ABORT, 'test posting failure'); END"
    )
    .run();
  await receivePaymentWebhook(db, "retryable", outcome(a), NOW);
  await assert.rejects(
    applyPaymentWebhook(db, "retryable", NOW),
    /test posting failure/
  );
  let c = await getPaymentCollection(db, id);
  assert.deepEqual(
    [c.paidCents, c.reservedCents, c.attempts[0].state],
    [0, 1176, "prepared"]
  );
  assert.equal((await listPaymentInbox(db)).length, 1);
  await db.prepare("DROP TRIGGER fail_payment_ledger").run();
  await Promise.all([
    applyPaymentWebhook(db, "retryable", NOW),
    ...Array.from({ length: 5 }, () =>
      applyPaymentOutcome(db, outcome(a), { now: NOW })
    ),
    ...Array.from({ length: 5 }, () =>
      applyPaymentOutcome(db, outcome(a, "pending"), { now: NOW })
    )
  ]);
  c = await getPaymentCollection(db, id);
  assert.deepEqual(
    [c.status, c.paidCents, c.reservedCents, c.attempts[0].state],
    ["paid", 1176, 0, "succeeded"]
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) AS n FROM payments").first()).n,
    1
  );
  assert.deepEqual(await reconcile(db), []);
});

test("preparePaymentAttempt fences the evaluated decline and requires an elapsed soft gate even for manual callers", async (t) => {
  const { db, id, owner } = await setup(t);
  const original = await prepare(db, owner);
  await applyPaymentOutcome(
    db,
    outcome(original, "declined", { declineType: "soft" }),
    { now: NOW }
  );
  const previous = (await getPaymentCollection(db, id)).attempts.at(-1);
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW, original)).kind,
    "reevaluate"
  );
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW, previous)).kind,
    "reevaluate"
  );
  const deadline = new Date(Number(NOW) + 3000);
  await recordCollectionNotice(
    db,
    owner,
    {
      id: "fenced-soft-gate",
      attemptNumber: 1,
      kind: "retry_scheduled",
      message: "Retry after durable deadline",
      deadlineAt: deadline.toISOString()
    },
    NOW
  );
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW, previous)).kind,
    "reevaluate"
  );
  // Neither the omitted gate nor a stale unresolved/decline-kind snapshot authorizes a retry.
  assert.equal(
    (await preparePaymentAttempt(db, owner, deadline)).kind,
    "reevaluate"
  );
  assert.equal(
    (await preparePaymentAttempt(db, owner, deadline, original)).kind,
    "reevaluate"
  );
  assert.equal(
    (
      await preparePaymentAttempt(db, owner, deadline, {
        ...previous,
        declineType: "hard"
      })
    ).kind,
    "reevaluate"
  );
  assert.equal((await getPaymentCollection(db, id)).attemptsUsed, 1);
  const ready = await preparePaymentAttempt(db, owner, deadline, previous);
  assert.equal(ready.kind, "attempt");
  assert.equal(ready.created, true);
  assert.equal(ready.attempt.attemptNumber, 2);
  assert.equal(
    (await getPaymentCollection(db, id)).reservedCents,
    original.amountCents
  );
  assert.deepEqual(await reconcile(db), []);
});

test("preparePaymentAttempt hard gate requires both exact declined snapshot and newer method", async (t) => {
  const { db, id, owner } = await setup(t);
  const original = await prepare(db, owner);
  await applyPaymentOutcome(
    db,
    outcome(original, "declined", { declineType: "hard" }),
    { now: NOW }
  );
  const previous = (await getPaymentCollection(db, id)).attempts.at(-1);
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW, previous)).kind,
    "reevaluate"
  );
  await updatePaymentMethod(db, "cus_acme", 1);
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW)).kind,
    "reevaluate"
  );
  assert.equal(
    (await preparePaymentAttempt(db, owner, NOW, original)).kind,
    "reevaluate"
  );
  const ready = await preparePaymentAttempt(db, owner, NOW, previous);
  assert.equal(ready.kind, "attempt");
  assert.equal(ready.attempt.methodVersion, 2);
  assert.equal(ready.attempt.attemptNumber, 2);
  assert.deepEqual(await reconcile(db), []);
});

for (const declineType of ["soft", "hard"]) {
  test(`preparePaymentAttempt returns its atomic snapshot when ${declineType} decline arrives after batch commit`, async (t) => {
    const { db, id, owner } = await setup(t);
    let original;
    let batches = 0;
    const raced = {
      prepare: db.prepare.bind(db),
      async batch(statements) {
        batches++;
        const results = await db.batch(statements);
        // The reservation was committed but its caller has not yet received its result.
        original = (await getPaymentCollection(db, id)).attempts[0];
        await applyPaymentOutcome(
          db,
          outcome(original, "declined", { declineType }),
          { now: NOW }
        );
        return results;
      }
    };
    const result = await preparePaymentAttempt(raced, owner, NOW);
    assert.equal(
      batches,
      1,
      "preparation must not read a second, racing decision snapshot"
    );
    assert.equal(result.kind, "attempt");
    assert.equal(result.created, true);
    assert.equal(result.attempt.state, "prepared");
    const actual = await getPaymentCollection(db, id);
    assert.equal(actual.attempts[0].state, "declined");
    assert.equal(actual.attemptsUsed, 1);
    assert.equal(actual.reservedCents, 0);
    assert.equal(
      (await preparePaymentAttempt(db, owner, NOW, original)).kind,
      "reevaluate"
    );
  });
}
