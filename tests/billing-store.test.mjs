// Runs the billing store against a real (in-memory) D1 database.
import assert from "node:assert/strict";
import test from "node:test";
import {
  finalizeInvoice,
  getCustomer,
  getInvoice,
  getUsageSummary,
  invoiceIdFor,
  issueCredit,
  listCustomers,
  listInvoices,
  monthPeriod,
  openInvoice,
  reconcile,
  recordUsage
} from "../src/billing/store.ts";
import { NOW, code, database, invoice } from "./helpers/d1.mjs";

test("seeded invoices match hand-calculated totals", async (t) => {
  const db = await database(t);
  const expected = {
    cus_acme: { "2026-08": 500, "2026-09": 1176 },
    cus_nimbus: { "2026-08": 20000, "2026-09": 33000 },
    cus_orbit: { "2026-08": 500, "2026-09": 500 }
  };
  for (const [customerId, months] of Object.entries(expected)) {
    for (const [month, total] of Object.entries(months)) {
      const result = await invoice(db, customerId, month);
      assert.equal(result.status, "finalized");
      assert.equal(result.totalCents, total, `${customerId} ${month}`);
    }
  }

  const detail = await getInvoice(db, invoiceIdFor("cus_acme", "2026-09"));
  assert.deepEqual(
    detail.lines.map((l) => [l.meterId, l.quantity, l.amountCents]),
    [
      [null, 1, 500],
      ["ai_neurons", 300_000, 0],
      ["ai_neurons", 300_000, 330],
      ["workers_requests", 10_000_000, 0],
      ["workers_requests", 11_525_000, 346]
    ]
  );
  assert.equal((await getCustomer(db, "cus_acme")).balanceCents, 1676);
  assert.deepEqual(await reconcile(db), []);
});

test("usage ingestion is idempotent and validated", async (t) => {
  const db = await database(t);
  const event = {
    id: "evt-1",
    customerId: "cus_acme",
    meterId: "workers_requests",
    quantity: 1000,
    occurredAt: "2026-10-07T08:00:00Z"
  };
  assert.deepEqual(await recordUsage(db, event, NOW), { status: "recorded" });
  assert.deepEqual(await recordUsage(db, event, NOW), { status: "duplicate" });
  await assert.rejects(
    recordUsage(db, { ...event, quantity: 2000 }, NOW),
    code("conflict")
  );
  await assert.rejects(
    recordUsage(db, { ...event, id: "evt-2", customerId: "cus_missing" }, NOW),
    code("not_found")
  );
  await assert.rejects(
    recordUsage(
      db,
      { ...event, id: "evt-3", occurredAt: "2026-10-08T00:00:00Z" },
      NOW
    ),
    code("invalid")
  );
  for (const quantity of [0, -5, 1.5, "10"]) {
    await assert.rejects(
      recordUsage(db, { ...event, id: "evt-4", quantity }, NOW),
      code("invalid")
    );
  }
  const october = await getUsageSummary(db, "cus_acme", "2026-10");
  const requests = october.meters.find((m) => m.meterId === "workers_requests");
  assert.deepEqual([requests.quantity, requests.events], [4_201_000, 7]);
});

test("month boundaries remain sortable four-digit dates and reject expanded years", async (t) => {
  assert.deepEqual(monthPeriod("2026-12"), {
    start: "2026-12-01T00:00:00.000Z",
    end: "2027-01-01T00:00:00.000Z"
  });
  assert.equal(monthPeriod("2000-01").start, "2000-01-01T00:00:00.000Z");
  assert.equal(monthPeriod("9999-11").end, "9999-12-01T00:00:00.000Z");
  const db = await database(t);
  for (const month of [
    "9999-12",
    "0000-01",
    "0099-12",
    "1999-12",
    "10000-01"
  ]) {
    assert.throws(() => monthPeriod(month), code("invalid"));
    await assert.rejects(
      openInvoice(db, "cus_acme", month, NOW),
      code("invalid")
    );
  }
  for (const month of ["2026-10", "2026-11", "9999-11"]) {
    await assert.rejects(
      openInvoice(db, "cus_acme", month, NOW),
      code("period_open")
    );
  }
  assert.deepEqual(await listInvoices(db, "cus_acme"), []);
  assert.equal(
    (await openInvoice(db, "cus_acme", "2026-09", NOW)).status,
    "draft"
  );
});

test("an invoice closes its period to new usage", async (t) => {
  const db = await database(t);
  await assert.rejects(
    openInvoice(db, "cus_acme", "2026-10", NOW),
    code("period_open")
  );
  await openInvoice(db, "cus_acme", "2026-09", NOW);
  const late = {
    id: "late-1",
    customerId: "cus_acme",
    meterId: "workers_requests",
    quantity: 1,
    occurredAt: "2026-09-30T23:59:59Z"
  };
  await assert.rejects(recordUsage(db, late, NOW), code("period_closed"));
  // Other customers' September and Acme's October are still open
  assert.equal(
    (await recordUsage(db, { ...late, customerId: "cus_orbit" }, NOW)).status,
    "recorded"
  );
  assert.equal(
    (
      await recordUsage(
        db,
        { ...late, id: "late-2", occurredAt: "2026-10-01T00:00:00Z" },
        NOW
      )
    ).status,
    "recorded"
  );
  await assert.rejects(
    openInvoice(db, "cus_missing", "2026-09", NOW),
    code("not_found")
  );
});

test("finalizing is idempotent, including concurrent runs", async (t) => {
  const db = await database(t);
  const draft = await openInvoice(db, "cus_acme", "2026-09", NOW);
  assert.equal(
    (await openInvoice(db, "cus_acme", "2026-09", NOW)).id,
    draft.id
  );

  const runs = await Promise.all(
    [1, 2, 3].map(() => finalizeInvoice(db, draft.id, NOW))
  );
  assert.deepEqual(new Set(runs.map((r) => r.totalCents)), new Set([1176]));
  const later = new Date("2026-10-08T00:00:00Z");
  assert.equal(
    (await finalizeInvoice(db, draft.id, later)).finalizedAt,
    runs[0].finalizedAt
  );

  assert.equal((await getInvoice(db, draft.id)).lines.length, 5);
  const { results } = await db
    .prepare(
      "SELECT account, amount_cents FROM ledger_entries ORDER BY account"
    )
    .all();
  assert.deepEqual(results, [
    { account: "accounts_receivable", amount_cents: 1176 },
    { account: "revenue", amount_cents: -1176 }
  ]);
  assert.deepEqual(await reconcile(db), []);
});

test("credits are capped at the invoice total and idempotent", async (t) => {
  const db = await database(t);
  const { id: invoiceId } = await invoice(db, "cus_acme", "2026-09");
  const credit = {
    id: "credit-1",
    invoiceId,
    amountCents: 1000,
    reason: "Outage on Sep 15",
    approvedBy: "support@example.com"
  };
  assert.equal((await issueCredit(db, credit, NOW)).status, "issued");
  assert.equal((await issueCredit(db, credit, NOW)).status, "duplicate");
  await assert.rejects(
    issueCredit(db, { ...credit, amountCents: 999 }, NOW),
    code("conflict")
  );
  // Only $1.76 remains creditable
  await assert.rejects(
    issueCredit(db, { ...credit, id: "credit-2", amountCents: 177 }, NOW),
    code("conflict")
  );
  assert.equal(
    (
      await issueCredit(
        db,
        { ...credit, id: "credit-3", amountCents: 176 },
        NOW
      )
    ).status,
    "issued"
  );

  const draft = await openInvoice(db, "cus_orbit", "2026-09", NOW);
  await assert.rejects(
    issueCredit(db, { ...credit, id: "credit-4", invoiceId: draft.id }, NOW),
    code("conflict")
  );
  await assert.rejects(
    issueCredit(
      db,
      { ...credit, id: "credit-5", invoiceId: "inv_missing" },
      NOW
    ),
    code("not_found")
  );
  await assert.rejects(
    issueCredit(db, { ...credit, id: "credit-6", reason: " " }, NOW),
    code("invalid")
  );

  assert.equal((await getCustomer(db, "cus_acme")).balanceCents, 0);
  const [listed] = await listInvoices(db, "cus_acme");
  assert.deepEqual([listed.totalCents, listed.creditedCents], [1176, 1176]);
  assert.equal((await getInvoice(db, invoiceId)).credits.length, 2);
  assert.deepEqual(await reconcile(db), []);
});

test("the ledger is append-only and reconciliation detects tampering", async (t) => {
  const db = await database(t);
  const { id } = await invoice(db, "cus_nimbus", "2026-09");
  await assert.rejects(
    db.prepare("UPDATE ledger_entries SET amount_cents = 1").run(),
    /immutable/
  );
  await assert.rejects(
    db.prepare("DELETE FROM ledger_entries").run(),
    /immutable/
  );

  await db
    .prepare(
      `INSERT INTO ledger_entries (transaction_id, account, customer_id, amount_cents, description, created_at)
       VALUES ('manual:1', 'revenue', 'cus_nimbus', -100, 'one-sided entry', ?)`
    )
    .bind(NOW.toISOString())
    .run();
  await db
    .prepare("UPDATE invoices SET total_cents = 1 WHERE id = ?")
    .bind(id)
    .run();

  assert.deepEqual(
    (await reconcile(db)).map((issue) => [issue.check, issue.reference]),
    [
      ["unbalanced_transaction", "manual:1"],
      ["invoice_total_mismatch", id],
      ["invoice_not_posted", id]
    ]
  );
});

test("customer listing includes balances", async (t) => {
  const db = await database(t);
  await invoice(db, "cus_orbit", "2026-08");
  assert.deepEqual(
    (await listCustomers(db)).map((c) => [c.id, c.planName, c.balanceCents]),
    [
      ["cus_acme", "Standard", 0],
      ["cus_nimbus", "Scale", 0],
      ["cus_orbit", "Standard", 500]
    ]
  );
  await assert.rejects(getCustomer(db, "cus_missing"), code("not_found"));
  await assert.rejects(getInvoice(db, "inv_missing"), code("not_found"));
});
