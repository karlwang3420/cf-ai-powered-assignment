// Typed client for the billing JSON API (src/api.ts), used by the UI.
import type {
  PaymentCollection,
  PaymentDetail,
  PaymentInboxEvent
} from "./billing/payments";
import type { DemoStatus, LocalDemoStatus } from "./demo/session";
import type {
  ChargeState,
  ProcessorCharge,
  ProcessorInspection,
  ProcessorScenario
} from "./payments/protocol";

export type { ProcessorInspection };
import type { reconcilePaymentCollections } from "./payments/service";
import type {
  CustomerSummary,
  InvoiceDetail,
  InvoiceSummary,
  MeterUsage
} from "./billing/store";

export type PaymentReconciliation = Awaited<
  ReturnType<typeof reconcilePaymentCollections>
>;
export type PaymentRun = {
  id: string | null;
  status: InstanceStatus["status"] | "not_started" | "unavailable";
  output?: {
    invoiceId: string;
    status: PaymentCollection["status"];
    attemptsUsed: number;
  };
  error?: { name: string; message: string } | null;
};

/** A demo control's result: the new event and the charge it carries. */
export type ProcessorAction = {
  invoiceId: string;
  eventId: string;
  charge: ProcessorCharge;
};

const paymentPath = (id: string) => `/api/payments/${encodeURIComponent(id)}`;
const jsonBody = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});

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
  payments: (customerId: string) =>
    request<PaymentCollection[]>(
      `/api/payments?customerId=${encodeURIComponent(customerId)}`
    ),
  paymentInbox: (customerId: string) =>
    request<PaymentInboxEvent[]>(
      `/api/payments/inbox?customerId=${encodeURIComponent(customerId)}`
    ),
  allPayments: () => request<PaymentCollection[]>("/api/payments"),
  allPaymentInbox: () =>
    request<PaymentInboxEvent[]>("/api/payments/inbox?all=true"),
  payment: (id: string) => request<PaymentDetail>(paymentPath(id)),
  paymentRun: (id: string) => request<PaymentRun>(`${paymentPath(id)}/run`),
  collectPayment: (id: string) =>
    request<{ id: string | null; started: boolean; collection: PaymentDetail }>(
      `${paymentPath(id)}/collect`,
      { method: "POST" }
    ),
  /** Admin retry: once automatic attempts are used, allows one manual attempt. */
  retryPayment: (id: string) =>
    request<{ id: string | null; started: boolean; collection: PaymentDetail }>(
      `${paymentPath(id)}/retry`,
      { method: "POST" }
    ),
  /** Omit invoiceId to reconcile every invoice and unapplied event. */
  reconcilePayments: (invoiceId?: string, resume = false) =>
    request<PaymentReconciliation>(
      "/api/payments/reconcile",
      jsonBody("POST", { invoiceId, resume })
    ),
  updatePaymentMethod: (customerId: string, expectedVersion: number) =>
    request<{ customerId: string; methodVersion: number }>(
      "/api/payments/method",
      jsonBody("POST", { customerId, expectedVersion })
    ),
  /** Local debug only: clear payment history and return to unpaid. */
  debugResetPayment: (id: string) =>
    request<PaymentDetail>(`${paymentPath(id)}/debug-reset`, {
      method: "POST"
    }),
  /** Mock processor moves a charge to another state and sends its webhook. */
  decideCharge: (
    id: string,
    processorPaymentId: string,
    outcome: ChargeState
  ) =>
    request<ProcessorAction>(
      `${paymentPath(id)}/processor/decide`,
      jsonBody("POST", { processorPaymentId, outcome })
    ),
  /** Mock processor sends a new event for a charge's current state. */
  notifyCharge: (id: string, processorPaymentId: string) =>
    request<ProcessorAction>(
      `${paymentPath(id)}/processor/notify`,
      jsonBody("POST", { processorPaymentId })
    ),
  /** Mock processor sends a dropped or given-up event again. */
  deliverEvent: (id: string, eventId: string) =>
    request<{ invoiceId: string; eventId: string }>(
      `${paymentPath(id)}/processor/deliver`,
      jsonBody("POST", { eventId })
    ),
  /** Mock processor's outcome queue, charges and deliveries for this invoice. */
  paymentProcessor: (id: string) =>
    request<ProcessorInspection>(`${paymentPath(id)}/processor`),
  paymentScenarios: (id: string, scenarios: ProcessorScenario[]) =>
    request<{ invoiceId: string; scenarios: ProcessorScenario[] }>(
      `${paymentPath(id)}/scenarios`,
      jsonBody("PUT", { scenarios })
    ),
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
    request<InvoiceRun>(`/api/invoice-runs/${encodeURIComponent(id)}`),
  /** Hosted demo status; `enabled: false` in local dev. */
  demo: () => request<DemoStatus | LocalDemoStatus>("/api/demo"),
  /** Return every customer to the seed; hosted, that is for everyone. */
  resetDemo: () => request<DemoStatus>("/api/demo/reset", { method: "POST" })
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
