/**
 * JSON API for the billing panel. Reads come straight from D1; invoice runs
 * are started as Workflows. Credits are deliberately not exposed here: they
 * are only issued through the assistant after a person approves them.
 *
 * There is no authentication of its own: locally this is a demo over seeded
 * data, and the hosted demo sits behind Cloudflare Access (see demo/gate.ts).
 */
import {
  BillingError,
  firstBillableMonth,
  getCustomer,
  getInvoice,
  getUsageSummary,
  invoiceIdFor,
  listCustomers,
  listInvoices,
  monthPeriod,
  type BillingErrorCode
} from "./billing/store.ts";

import type { DemoEnv } from "./demo/gate.ts";
import type { DemoStatus } from "./demo/session.ts";
import { isCrossSite } from "./origin.ts";
import { handlePaymentApi } from "./payments/api.ts";
import { paymentLog, type PaymentEnv } from "./payments/service.ts";

export type ApiEnv = PaymentEnv &
  Pick<DemoEnv, "DEMO_SESSION"> & {
    DB: D1Database;
    INVOICE_WORKFLOW: Pick<Workflow, "create" | "get">;
  };

const STATUS: Record<BillingErrorCode, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  period_closed: 409,
  period_open: 409
};

const json = (data: unknown, status = 200) => Response.json(data, { status });
const error = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

const monthOf = (date: Date) => date.toISOString().slice(0, 7);

/** Ended, billable months for a customer, newest first. */
export function endedMonths(
  createdAt: string,
  now: Date,
  limit = 12
): string[] {
  const months: string[] = [];
  const cursor = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  );
  const first = firstBillableMonth(createdAt);
  while (months.length < limit && monthOf(cursor) >= first) {
    months.push(monthOf(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return months;
}

async function customerDetail(env: ApiEnv, customerId: string, now: Date) {
  const [customer, invoices] = await Promise.all([
    getCustomer(env.DB, customerId),
    listInvoices(env.DB, customerId)
  ]);
  const currentMonth = monthOf(now);
  return {
    customer,
    invoices,
    currentUsage: await getUsageSummary(env.DB, customerId, currentMonth),
    // Months that can be invoiced, with their invoice status if any
    months: endedMonths(customer.createdAt, now).map((month) => ({
      month,
      status:
        invoices.find((i) => i.id === invoiceIdFor(customerId, month))
          ?.status ?? "not_invoiced"
    }))
  };
}

async function startInvoiceRun(env: ApiEnv, request: Request, now: Date) {
  let body: { customerId?: unknown; month?: unknown };
  try {
    body = await request.json();
  } catch {
    return error(400, "invalid", "request body must be JSON");
  }
  const { customerId, month } = body;
  if (typeof customerId !== "string" || typeof month !== "string") {
    return error(400, "invalid", "customerId and month are required");
  }
  // Fail fast on requests the workflow would reject anyway
  await getCustomer(env.DB, customerId);
  if (monthPeriod(month).end > now.toISOString()) {
    return error(409, "period_open", `${month} has not ended yet`);
  }
  const instance = await env.INVOICE_WORKFLOW.create({
    params: { customerId, month }
  });
  return json({ id: instance.id }, 202);
}

/**
 * Returns a response for /api/* requests, or null for anything else. `demo` is
 * the hosted demo's status for this request, or null when demo mode is off.
 */
export async function handleApi(
  request: Request,
  env: ApiEnv,
  now = new Date(),
  demo: DemoStatus | null = null
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/")) return null;
  // Browser forms can POST to loopback without a CORS preflight. Check before
  // dispatch (including bodyless collect/reset); CLI calls have no Origin.
  // The exact processor callback authenticates its raw body with HMAC instead.
  const webhook =
    request.method === "POST" && url.pathname === "/api/payments/webhook";
  if (
    !webhook &&
    !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    isCrossSite(request)
  ) {
    return error(403, "forbidden", "Cross-origin mutations are not allowed");
  }
  const parts = url.pathname.split("/").slice(2).map(decodeURIComponent);
  const route = `${request.method} ${parts[0]}${parts.length > 1 ? "/:id" : ""}`;

  try {
    const payment = await handlePaymentApi(request, env);
    if (payment) return payment;
    switch (route) {
      case "GET customers":
        return json(await listCustomers(env.DB));
      case "GET customers/:id":
        return json(await customerDetail(env, parts[1], now));
      case "GET invoices/:id":
        return json(await getInvoice(env.DB, parts[1]));
      case "POST invoice-runs":
        return await startInvoiceRun(env, request, now);
      case "GET demo":
        return json(demo ?? { enabled: false });
      case "POST demo/:id":
        if (parts[1] !== "reset" || !demo || !env.DEMO_SESSION) break;
        // Admitting this request may already have reset the demo
        if (demo.reset) return json(demo);
        return json(await env.DEMO_SESSION.getByName("demo").reset());
      case "GET invoice-runs/:id": {
        let instance: WorkflowInstance;
        try {
          instance = await env.INVOICE_WORKFLOW.get(parts[1]);
        } catch {
          return error(404, "not_found", `unknown invoice run "${parts[1]}"`);
        }
        const { status, output, error: failure } = await instance.status();
        return json({ id: instance.id, status, output, error: failure });
      }
    }
    return error(
      404,
      "not_found",
      `no route for ${request.method} ${url.pathname}`
    );
  } catch (err) {
    if (err instanceof BillingError)
      return error(STATUS[err.code], err.code, err.message);
    if (parts[0] === "payments") {
      // Transport errors may carry raw processor data; log only safe correlation fields.
      paymentLog(
        "payment_api_failed",
        {
          ...(parts.length === 3 ||
          (parts.length === 2 && request.method === "GET")
            ? { invoiceId: parts[1] }
            : {})
        },
        { method: request.method }
      );
    } else console.error("API error", err);
    return error(500, "internal", "internal error");
  }
}
