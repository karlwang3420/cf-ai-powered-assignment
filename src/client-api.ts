// Typed client for the billing JSON API (src/api.ts), used by the UI.
import type {
  CustomerSummary,
  InvoiceDetail,
  InvoiceSummary,
  MeterUsage
} from "./billing/store";

export type CustomerDetail = {
  customer: CustomerSummary;
  invoices: InvoiceSummary[];
  currentUsage: { month: string; meters: MeterUsage[] };
  months: { month: string; status: "draft" | "finalized" | "not_invoiced" }[];
};

export type InvoiceRun = {
  id: string;
  status: InstanceStatus["status"];
  output?: {
    invoiceId: string;
    totalCents: number | null;
    reconciliationIssues: number;
  };
  error?: { name: string; message: string } | null;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const data = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(
      data?.error?.message ?? `Request failed (${response.status})`
    );
  }
  return data as T;
}

export const api = {
  customers: () => request<CustomerSummary[]>("/api/customers"),
  customer: (id: string) =>
    request<CustomerDetail>(`/api/customers/${encodeURIComponent(id)}`),
  invoice: (id: string) =>
    request<InvoiceDetail>(`/api/invoices/${encodeURIComponent(id)}`),
  startInvoiceRun: (customerId: string, month: string) =>
    request<{ id: string }>("/api/invoice-runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ customerId, month })
    }),
  invoiceRun: (id: string) =>
    request<InvoiceRun>(`/api/invoice-runs/${encodeURIComponent(id)}`)
};

/** "2026-09" → "September 2026" */
export function monthLabel(month: string): string {
  return new Date(`${month}-01T00:00:00Z`).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

/** Month n months before the current UTC month, as YYYY-MM. */
export function monthsAgo(n: number, now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - n, 1))
    .toISOString()
    .slice(0, 7);
}
