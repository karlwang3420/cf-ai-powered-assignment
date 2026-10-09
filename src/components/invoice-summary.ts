import type { InvoiceLine } from "../billing/pricing";

export type InvoiceSummaryRow = {
  key: string;
  service: string;
  quantity: number | null;
  unit: string;
  amountCents: number;
};

/** Presentation only: add frozen tier quantities and already-rounded costs. */
export function summarizeInvoiceLines(
  lines: readonly InvoiceLine[]
): InvoiceSummaryRow[] {
  const rows = new Map<string, InvoiceSummaryRow>();
  for (const line of lines) {
    const usage = line.kind === "usage" && line.meterId !== null;
    const key = usage ? `meter:${line.meterId}` : `line:${line.lineNo}`;
    const existing = rows.get(key);
    if (existing) {
      existing.quantity! += line.quantity;
      existing.amountCents += line.amountCents;
      continue;
    }
    rows.set(key, {
      key,
      service: usage
        ? line.description.split(":")[0]
        : line.kind === "subscription"
          ? "Plan fee"
          : line.description,
      quantity: usage ? line.quantity : null,
      unit:
        line.meterId === "ai_neurons"
          ? "neurons"
          : line.meterId === "workers_requests"
            ? "requests"
            : "",
      amountCents: line.amountCents
    });
  }
  return [...rows.values()];
}
