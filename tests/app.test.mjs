// The layers on top of the billing store: reports, assistant tools, and the
// JSON API, all against a real (in-memory) D1 database.
import assert from "node:assert/strict";
import test from "node:test";
import { endedMonths, handleApi } from "../src/api.ts";
import { CREDIT_APPROVER, createBillingTools } from "../src/assistant-tools.ts";
import {
  compareMonths,
  getDailyUsage,
  percentChange
} from "../src/billing/reports.ts";
import {
  firstBillableMonth,
  getInvoice,
  openInvoice
} from "../src/billing/store.ts";
import { NOW, code, database, invoice } from "./helpers/d1.mjs";

test("billing starts with the customer's first full month", async (t) => {
  assert.equal(firstBillableMonth("2026-07-15T00:00:00.000Z"), "2026-08");
  assert.equal(firstBillableMonth("2026-08-01T00:00:00.000Z"), "2026-08");
  assert.equal(firstBillableMonth("2026-12-31T23:59:59.000Z"), "2027-01");
  assert.deepEqual(endedMonths("2026-07-15T00:00:00.000Z", NOW), [
    "2026-09",
    "2026-08"
  ]);

  const db = await database(t);
  // Orbit was created mid-July; with no proration, July cannot be invoiced
  await assert.rejects(
    openInvoice(db, "cus_orbit", "2026-07", NOW),
    code("invalid")
  );
});

test("month comparison precomputes usage and charge changes", async (t) => {
  const db = await database(t);
  assert.equal(percentChange(0, 10), null);
  assert.equal(percentChange(7_750_000, 21_525_000), 177.7);

  const before = await compareMonths(db, "cus_acme", "2026-08", "2026-09");
  assert.deepEqual(before.invoiceTotals, {
    previous: null,
    current: null,
    changeCents: null
  });
  assert.equal(before.meters[0].currentChargeCents, null);

  await invoice(db, "cus_acme", "2026-08");
  await invoice(db, "cus_acme", "2026-09");
  const after = await compareMonths(db, "cus_acme", "2026-08", "2026-09");
  assert.deepEqual(
    after.meters.map((m) => [
      m.meterId,
      m.change,
      m.previousChargeCents,
      m.currentChargeCents
    ]),
    [
      ["ai_neurons", 352_000, 0, 330],
      ["workers_requests", 13_775_000, 0, 346]
    ]
  );
  assert.deepEqual(after.invoiceTotals, {
    previous: 500,
    current: 1176,
    changeCents: 676
  });
});

test("daily usage flags spikes against the median", async (t) => {
  const db = await database(t);
  const usage = await getDailyUsage(db, "cus_nimbus", "2026-09", "ai_neurons");
  assert.equal(usage.days.length, 30);
  assert.equal(usage.total, 24_000_000);
  assert.equal(usage.medianPerDay, 250_000);
  assert.deepEqual(usage.peak, { day: "2026-09-15", quantity: 3_000_000 });
  assert.deepEqual(
    usage.unusualDays.map((d) => d.day),
    [
      "2026-09-15",
      "2026-09-16",
      "2026-09-17",
      "2026-09-18",
      "2026-09-19",
      "2026-09-20"
    ]
  );
});

test("assistant tools are scoped to one customer and format money", async (t) => {
  const db = await database(t);
  await invoice(db, "cus_acme", "2026-09");
  const acme = createBillingTools(db, "cus_acme");
  const orbit = createBillingTools(db, "cus_orbit");
  const options = { toolCallId: "call-1", messages: [] };

  const overview = await acme.getAccountOverview.execute({}, options);
  assert.equal(overview.balanceOwed, "$11.76");
  assert.deepEqual(overview.invoices, [
    {
      month: "2026-09",
      status: "finalized",
      total: "$11.76",
      credited: "$0.00"
    }
  ]);

  const september = await acme.getInvoice.execute(
    { month: "2026-09" },
    options
  );
  assert.equal(september.total, "$11.76");
  assert.equal(september.lines.length, 5);
  // Orbit's tools cannot see Acme's invoice: they only look up Orbit's own
  assert.match(
    (await orbit.getInvoice.execute({ month: "2026-09" }, options)).error,
    /unknown invoice/
  );
  assert.match(
    (await acme.getInvoice.execute({ month: "2026-08" }, options)).error,
    /unknown invoice/
  );
});

test("the credit tool needs approval and is idempotent per tool call", async (t) => {
  const db = await database(t);
  const { id } = await invoice(db, "cus_acme", "2026-09");
  const { issueCredit } = createBillingTools(db, "cus_acme");
  assert.equal(issueCredit.needsApproval, true);

  const input = {
    month: "2026-09",
    amount: "5.00",
    reason: "Outage on Sep 16"
  };
  const first = await issueCredit.execute(input, {
    toolCallId: "call-1",
    messages: []
  });
  assert.match(first.result, /applied/);
  assert.equal(first.credited, "$5.00");
  // Replaying the same approved tool call does not credit twice
  const replay = await issueCredit.execute(input, {
    toolCallId: "call-1",
    messages: []
  });
  assert.match(replay.result, /Already applied/);

  await assert.rejects(
    issueCredit.execute(
      { ...input, amount: "five" },
      { toolCallId: "call-2", messages: [] }
    ),
    code("invalid")
  );
  await assert.rejects(
    issueCredit.execute(
      { ...input, amount: "100" },
      { toolCallId: "call-3", messages: [] }
    ),
    /only \$6\.76 can still be credited/
  );

  const detail = await getInvoice(db, id);
  assert.deepEqual(
    detail.credits.map((c) => [c.id, c.amountCents, c.approvedBy]),
    [["call-1", 500, CREDIT_APPROVER]]
  );
});

function fakeWorkflow() {
  const created = [];
  return {
    created,
    async create({ params }) {
      created.push(params);
      return { id: "run-1" };
    },
    async get(id) {
      if (id !== "run-1") throw new Error("instance not found");
      return {
        id,
        status: async () => ({
          status: "complete",
          output: {
            invoiceId: "inv_cus_acme_2026-09",
            totalCents: 1176,
            reconciliationIssues: 0
          },
          __LOCAL_DEV_STEP_OUTPUTS: ["internal"]
        })
      };
    }
  };
}

test("API: reads, invoice runs, and error statuses", async (t) => {
  const env = { DB: await database(t), INVOICE_WORKFLOW: fakeWorkflow() };
  const call = async (method, path, body) => {
    const response = await handleApi(
      new Request(`http://localhost${path}`, {
        method,
        body,
        headers: body ? { "content-type": "application/json" } : undefined
      }),
      env,
      NOW
    );
    return response && { status: response.status, data: await response.json() };
  };

  assert.equal((await call("GET", "/api/customers")).data.length, 3);
  const acme = await call("GET", "/api/customers/cus_acme");
  assert.equal(acme.status, 200);
  assert.deepEqual(acme.data.months, [
    { month: "2026-09", status: "not_invoiced" },
    { month: "2026-08", status: "not_invoiced" }
  ]);
  assert.equal(acme.data.currentUsage.month, "2026-10");

  const started = await call(
    "POST",
    "/api/invoice-runs",
    JSON.stringify({ customerId: "cus_acme", month: "2026-09" })
  );
  assert.deepEqual([started.status, started.data], [202, { id: "run-1" }]);
  assert.deepEqual(env.INVOICE_WORKFLOW.created, [
    { customerId: "cus_acme", month: "2026-09" }
  ]);

  const run = await call("GET", "/api/invoice-runs/run-1");
  assert.equal(run.data.status, "complete");
  assert.equal(run.data.output.totalCents, 1176);
  assert.ok(!("__LOCAL_DEV_STEP_OUTPUTS" in run.data));

  const statuses = [
    await call(
      "POST",
      "/api/invoice-runs",
      JSON.stringify({ customerId: "cus_acme", month: "2026-10" })
    ),
    await call(
      "POST",
      "/api/invoice-runs",
      JSON.stringify({ customerId: "cus_nope", month: "2026-09" })
    ),
    await call("POST", "/api/invoice-runs", "not json"),
    await call(
      "POST",
      "/api/invoice-runs",
      JSON.stringify({ month: "2026-09" })
    ),
    await call("GET", "/api/invoice-runs/missing"),
    await call("GET", "/api/invoices/inv_missing"),
    await call("GET", "/api/customers/cus_nope"),
    await call("DELETE", "/api/customers")
  ].map((r) => [r.status, r.data.error.code]);
  assert.deepEqual(statuses, [
    [409, "period_open"],
    [404, "not_found"],
    [400, "invalid"],
    [400, "invalid"],
    [404, "not_found"],
    [404, "not_found"],
    [404, "not_found"],
    [404, "not_found"]
  ]);
  // Only the first, valid request started a workflow
  assert.equal(env.INVOICE_WORKFLOW.created.length, 1);
  assert.equal(await call("GET", "/agents/billing-assistant/cus_acme"), null);
});
