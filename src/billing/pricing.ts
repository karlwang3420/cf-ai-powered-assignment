/**
 * Pure pricing logic. Amounts are integer cents; unit prices are integer
 * micro-dollars (1/1,000,000 USD) per block of units, so rates such as
 * $0.011 per 1,000 neurons are exact. Nothing here touches the database.
 */

export type Plan = { id: string; name: string; monthlyFeeCents: number };
export type Meter = { id: string; name: string; unit: string };
export type PriceTier = {
  meterId: string;
  fromQuantity: number;
  unitPriceMicros: number;
  blockSize: number;
};

export type InvoiceLine = {
  lineNo: number;
  kind: "subscription" | "usage";
  meterId: string | null;
  description: string;
  quantity: number;
  unitPriceMicros: number;
  blockSize: number;
  amountCents: number;
};

const MICROS_PER_CENT = 10_000n;

function assertCount(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Price of `quantity` units at `unitPriceMicros` per `blockSize` units,
 * rounded half-up to whole cents. BigInt keeps the intermediate product exact.
 */
export function amountCents(
  quantity: number,
  unitPriceMicros: number,
  blockSize: number
): number {
  assertCount(quantity, "quantity");
  assertCount(unitPriceMicros, "unitPriceMicros");
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new RangeError("blockSize must be a positive safe integer");
  }
  const numerator = BigInt(quantity) * BigInt(unitPriceMicros);
  const denominator = BigInt(blockSize) * MICROS_PER_CENT;
  // floor((2n + d) / 2d) is n/d rounded half-up for non-negative values
  return Number((numerator * 2n + denominator) / (denominator * 2n));
}

export type RatedTier = PriceTier & {
  /** Exclusive upper bound, or null for the last tier */
  toQuantity: number | null;
  quantity: number;
  amountCents: number;
};

/**
 * Splits a meter's total usage across graduated tiers. Each tier is rounded
 * separately so invoice lines add up exactly to the invoice total.
 */
export function rateGraduated(
  quantity: number,
  tiers: PriceTier[]
): RatedTier[] {
  assertCount(quantity, "quantity");
  const sorted = [...tiers].sort((a, b) => a.fromQuantity - b.fromQuantity);
  if (sorted[0]?.fromQuantity !== 0) {
    throw new Error("price tiers must start at quantity 0");
  }
  return sorted.flatMap((tier, i) => {
    const next = sorted[i + 1]?.fromQuantity ?? null;
    if (next !== null && next <= tier.fromQuantity) {
      throw new Error("price tiers must have distinct start quantities");
    }
    const upper = next === null ? quantity : Math.min(quantity, next);
    const inTier = Math.max(0, upper - tier.fromQuantity);
    if (inTier === 0) return [];
    return [
      {
        ...tier,
        toQuantity: next,
        quantity: inTier,
        amountCents: amountCents(inTier, tier.unitPriceMicros, tier.blockSize)
      }
    ];
  });
}

/** Builds every line of a monthly invoice: the plan fee, then usage tiers. */
export function buildInvoiceLines(input: {
  plan: Plan;
  meters: Meter[];
  tiers: PriceTier[];
  /** Total usage in the period, by meter id */
  usage: Record<string, number>;
}): InvoiceLine[] {
  const { plan, meters, tiers, usage } = input;
  const lines: InvoiceLine[] = [
    {
      lineNo: 1,
      kind: "subscription",
      meterId: null,
      description: `${plan.name} plan (monthly fee)`,
      quantity: 1,
      unitPriceMicros: plan.monthlyFeeCents * Number(MICROS_PER_CENT),
      blockSize: 1,
      amountCents: plan.monthlyFeeCents
    }
  ];

  for (const meterId of Object.keys(usage).sort()) {
    const quantity = usage[meterId];
    if (quantity === 0) continue;
    const meter = meters.find((m) => m.id === meterId);
    const meterTiers = tiers.filter((t) => t.meterId === meterId);
    // Refuse to bill usage that has no price rather than silently dropping it
    if (!meter || meterTiers.length === 0) {
      throw new Error(`no price for meter "${meterId}" on plan "${plan.id}"`);
    }
    for (const rated of rateGraduated(quantity, meterTiers)) {
      lines.push({
        lineNo: lines.length + 1,
        kind: "usage",
        meterId,
        description: describeTier(meter, rated),
        quantity: rated.quantity,
        unitPriceMicros: rated.unitPriceMicros,
        blockSize: rated.blockSize,
        amountCents: rated.amountCents
      });
    }
  }
  return lines;
}

/** Parses "10", "10.5", or "10.50" dollars into exact cents, or returns null. */
export function parseDollars(value: string): number | null {
  const match = /^\$?(\d{1,9})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
}

export function formatCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}$${Math.floor(abs / 100).toLocaleString("en-US")}.${String(abs % 100).padStart(2, "0")}`;
}

/** $0.30, $0.011, $5.00: at least two decimals, more only when needed. */
export function formatMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000).toLocaleString("en-US");
  const fraction = String(micros % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `$${whole}.${fraction}`;
}

const count = (n: number) => n.toLocaleString("en-US");

function describeTier(meter: Meter, tier: RatedTier): string {
  if (tier.unitPriceMicros === 0) {
    return tier.toQuantity === null
      ? `${meter.name}: ${count(tier.quantity)} ${meter.unit} (no charge)`
      : `${meter.name}: ${count(tier.quantity)} of ${count(tier.toQuantity - tier.fromQuantity)} ${meter.unit} included`;
  }
  const range =
    tier.toQuantity === null
      ? `above ${count(tier.fromQuantity)}`
      : `${count(tier.fromQuantity)}–${count(tier.toQuantity)}`;
  return `${meter.name}: ${count(tier.quantity)} ${meter.unit} ${range} at ${formatMicros(tier.unitPriceMicros)} per ${count(tier.blockSize)}`;
}
