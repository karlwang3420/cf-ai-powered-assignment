import assert from "node:assert/strict";
import test from "node:test";
import { buildInvoiceLines } from "../src/billing/pricing.ts";
import { summarizeInvoiceLines } from "../src/components/invoice-summary.ts";

const pricedLines = (usage) =>
  buildInvoiceLines({
    plan: { id: "standard", name: "Standard", monthlyFeeCents: 500 },
    meters: [
      { id: "ai_neurons", name: "Workers AI", unit: "neurons" },
      { id: "workers_requests", name: "Workers requests", unit: "requests" }
    ],
    tiers: [
      {
        meterId: "ai_neurons",
        fromQuantity: 0,
        unitPriceMicros: 0,
        blockSize: 1000
      },
      {
        meterId: "ai_neurons",
        fromQuantity: 300000,
        unitPriceMicros: 11000,
        blockSize: 1000
      },
      {
        meterId: "workers_requests",
        fromQuantity: 0,
        unitPriceMicros: 0,
        blockSize: 1000000
      },
      {
        meterId: "workers_requests",
        fromQuantity: 10000000,
        unitPriceMicros: 300000,
        blockSize: 1000000
      }
    ],
    usage
  });

test("invoice summary combines included and paid tiers without changing frozen lines", () => {
  const lines = pricedLines({ ai_neurons: 600000, workers_requests: 21525000 });
  const original = structuredClone(lines);
  lines.forEach(Object.freeze);
  Object.freeze(lines);
  const rows = summarizeInvoiceLines(lines);
  assert.deepEqual(rows, [
    {
      key: "line:1",
      service: "Plan fee",
      quantity: null,
      unit: "",
      amountCents: 500
    },
    {
      key: "meter:ai_neurons",
      service: "Workers AI",
      quantity: 600000,
      unit: "neurons",
      amountCents: 330
    },
    {
      key: "meter:workers_requests",
      service: "Workers requests",
      quantity: 21525000,
      unit: "requests",
      amountCents: 346
    }
  ]);
  assert.equal(
    rows.reduce((sum, row) => sum + row.amountCents, 0),
    1176
  );
  assert.deepEqual(lines, original);
});

test("invoice summary retains free usage and handles draft and fee-only invoices", () => {
  assert.deepEqual(summarizeInvoiceLines([]), []);
  assert.equal(summarizeInvoiceLines(pricedLines({})).length, 1);
  const rows = summarizeInvoiceLines(
    pricedLines({ ai_neurons: 248000, workers_requests: 7750000 })
  );
  assert.deepEqual(
    rows.slice(1).map((row) => [row.quantity, row.amountCents]),
    [
      [248000, 0],
      [7750000, 0]
    ]
  );
});

test("invoice summary sums rounded cents rather than repricing combined usage", () => {
  const lines = [1, 2].map((lineNo) => ({
    lineNo,
    kind: "usage",
    meterId: "other",
    description: "Other service: tier detail",
    quantity: 5000,
    unitPriceMicros: 1,
    blockSize: 1,
    amountCents: 1
  }));
  assert.deepEqual(summarizeInvoiceLines(lines), [
    {
      key: "meter:other",
      service: "Other service",
      quantity: 10000,
      unit: "",
      amountCents: 2
    }
  ]);
});
