/**
 * Read-only analysis for explaining bills. Comparisons and statistics are
 * computed here so the assistant reports figures instead of doing arithmetic.
 */
import {
  getUsageSummary,
  invoiceIdFor,
  listInvoices,
  monthPeriod
} from "./store.ts";

/** Percent change rounded to one decimal place, or null if there is no baseline. */
export function percentChange(
  previous: number,
  current: number
): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export type MonthComparison = {
  previousMonth: string;
  currentMonth: string;
  meters: {
    meterId: string;
    name: string;
    unit: string;
    previous: number;
    current: number;
    change: number;
    changePercent: number | null;
    /** Invoiced usage charges for this meter in cents, or null if not invoiced */
    previousChargeCents: number | null;
    currentChargeCents: number | null;
  }[];
  /** Finalized invoice totals in cents, or null if a month is not invoiced */
  invoiceTotals: {
    previous: number | null;
    current: number | null;
    changeCents: number | null;
  };
};

export async function compareMonths(
  db: D1Database,
  customerId: string,
  previousMonth: string,
  currentMonth: string
): Promise<MonthComparison> {
  const [previous, current, invoices, charges] = await Promise.all([
    getUsageSummary(db, customerId, previousMonth),
    getUsageSummary(db, customerId, currentMonth),
    listInvoices(db, customerId),
    db
      .prepare(
        `SELECT i.period_start AS periodStart, l.meter_id AS meterId,
           SUM(l.amount_cents) AS cents
         FROM invoices i JOIN invoice_lines l ON l.invoice_id = i.id
         WHERE i.id IN (?, ?) AND i.status = 'finalized' AND l.meter_id IS NOT NULL
         GROUP BY i.id, l.meter_id`
      )
      .bind(
        invoiceIdFor(customerId, previousMonth),
        invoiceIdFor(customerId, currentMonth)
      )
      .all<{ periodStart: string; meterId: string; cents: number }>()
  ]);
  const total = (month: string) => {
    const invoice = invoices.find(
      (i) => i.id === invoiceIdFor(customerId, month)
    );
    return invoice?.status === "finalized" ? invoice.totalCents : null;
  };
  // A finalized invoice with no lines for a meter means $0 for that meter
  const charge = (month: string, meterId: string) =>
    total(month) === null
      ? null
      : (charges.results.find(
          (c) => c.periodStart.startsWith(month) && c.meterId === meterId
        )?.cents ?? 0);
  const previousTotal = total(previousMonth);
  const currentTotal = total(currentMonth);
  return {
    previousMonth,
    currentMonth,
    meters: current.meters.map((meter) => {
      const before =
        previous.meters.find((m) => m.meterId === meter.meterId)?.quantity ?? 0;
      return {
        meterId: meter.meterId,
        name: meter.name,
        unit: meter.unit,
        previous: before,
        current: meter.quantity,
        change: meter.quantity - before,
        changePercent: percentChange(before, meter.quantity),
        previousChargeCents: charge(previousMonth, meter.meterId),
        currentChargeCents: charge(currentMonth, meter.meterId)
      };
    }),
    invoiceTotals: {
      previous: previousTotal,
      current: currentTotal,
      changeCents:
        previousTotal === null || currentTotal === null
          ? null
          : currentTotal - previousTotal
    }
  };
}

export type DailyUsage = {
  month: string;
  meterId: string;
  days: { day: string; quantity: number }[];
  total: number;
  medianPerDay: number;
  peak: { day: string; quantity: number } | null;
  /** Days above twice the median, a simple spike heuristic */
  unusualDays: { day: string; quantity: number }[];
};

export async function getDailyUsage(
  db: D1Database,
  customerId: string,
  month: string,
  meterId: string
): Promise<DailyUsage> {
  const period = monthPeriod(month);
  const { results: days } = await db
    .prepare(
      `SELECT substr(occurred_at, 1, 10) AS day, SUM(quantity) AS quantity
       FROM usage_events
       WHERE customer_id = ? AND meter_id = ? AND occurred_at >= ? AND occurred_at < ?
       GROUP BY day ORDER BY day`
    )
    .bind(customerId, meterId, period.start, period.end)
    .all<{ day: string; quantity: number }>();

  const sorted = days.map((d) => d.quantity).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2
        ? sorted[middle]
        : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  const peak = days.reduce<DailyUsage["peak"]>(
    (best, d) => (!best || d.quantity > best.quantity ? d : best),
    null
  );
  return {
    month,
    meterId,
    days,
    total: days.reduce((sum, d) => sum + d.quantity, 0),
    medianPerDay: median,
    peak,
    unusualDays: days.filter((d) => median > 0 && d.quantity > median * 2)
  };
}
