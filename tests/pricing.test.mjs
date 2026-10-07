import assert from "node:assert/strict";
import test from "node:test";
import {
  amountCents,
  buildInvoiceLines,
  formatCents,
  formatMicros,
  rateGraduated
} from "../src/billing/pricing.ts";

const requestTiers = [
  { meterId: "req", fromQuantity: 0, unitPriceMicros: 0, blockSize: 1_000_000 },
  {
    meterId: "req",
    fromQuantity: 10_000_000,
    unitPriceMicros: 300_000,
    blockSize: 1_000_000
  }
];

test("amounts round half-up to whole cents", () => {
  assert.equal(amountCents(5_000, 1, 1), 1); // exactly half a cent
  assert.equal(amountCents(4_999, 1, 1), 0);
  assert.equal(amountCents(1_000, 11_000, 1_000), 1); // 1.1 cents
  assert.equal(amountCents(11_525_000, 300_000, 1_000_000), 346); // 345.75
  assert.equal(amountCents(0, 300_000, 1_000_000), 0);
});

test("large quantities stay exact", () => {
  // 9e15 requests at $0.30/M is $2,700,000,000.00 with no floating-point drift
  assert.equal(
    amountCents(9_000_000_000_000_000, 300_000, 1_000_000),
    270_000_000_000
  );
});

test("invalid amounts are rejected", () => {
  assert.throws(() => amountCents(1.5, 1, 1), RangeError);
  assert.throws(() => amountCents(-1, 1, 1), RangeError);
  assert.throws(() => amountCents(1, 1, 0), RangeError);
  assert.throws(
    () => amountCents(Number.MAX_SAFE_INTEGER + 1, 1, 1),
    RangeError
  );
});

test("graduated tiers split usage at the boundary", () => {
  const rated = rateGraduated(21_525_000, requestTiers);
  assert.deepEqual(
    rated.map((t) => [t.fromQuantity, t.toQuantity, t.quantity, t.amountCents]),
    [
      [0, 10_000_000, 10_000_000, 0],
      [10_000_000, null, 11_525_000, 346]
    ]
  );
  assert.deepEqual(
    rateGraduated(7_750_000, requestTiers).map((t) => t.quantity),
    [7_750_000]
  );
  assert.deepEqual(rateGraduated(0, requestTiers), []);
});

test("misconfigured tiers are rejected", () => {
  assert.throws(
    () => rateGraduated(1, [requestTiers[1]]),
    /start at quantity 0/
  );
  assert.throws(
    () => rateGraduated(1, [requestTiers[0], { ...requestTiers[0] }]),
    /distinct/
  );
});

test("invoice lines: fee first, then priced tiers per meter", () => {
  const lines = buildInvoiceLines({
    plan: { id: "standard", name: "Standard", monthlyFeeCents: 500 },
    meters: [{ id: "req", name: "Workers requests", unit: "requests" }],
    tiers: requestTiers,
    usage: { req: 21_525_000 }
  });
  assert.deepEqual(
    lines.map((l) => [l.lineNo, l.kind, l.amountCents, l.description]),
    [
      [1, "subscription", 500, "Standard plan (monthly fee)"],
      [
        2,
        "usage",
        0,
        "Workers requests: 10,000,000 of 10,000,000 requests included"
      ],
      [
        3,
        "usage",
        346,
        "Workers requests: 11,525,000 requests above 10,000,000 at $0.30 per 1,000,000"
      ]
    ]
  );
});

test("usage without a price fails instead of being dropped", () => {
  assert.throws(
    () =>
      buildInvoiceLines({
        plan: { id: "standard", name: "Standard", monthlyFeeCents: 500 },
        meters: [],
        tiers: [],
        usage: { gpu_seconds: 10 }
      }),
    /no price for meter "gpu_seconds"/
  );
});

test("money formatting", () => {
  assert.equal(formatMicros(300_000), "$0.30");
  assert.equal(formatMicros(11_000), "$0.011");
  assert.equal(formatMicros(5_000_000), "$5.00");
  assert.equal(formatMicros(1_234_567_000_000), "$1,234,567.00");
  assert.equal(formatCents(117_600), "$1,176.00");
  assert.equal(formatCents(-5), "-$0.05");
});
