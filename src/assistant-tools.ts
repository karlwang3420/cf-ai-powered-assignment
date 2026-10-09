/**
 * Tools the billing assistant can call. Each chat belongs to one customer and
 * the tools are scoped to that customer, so the model cannot read other
 * accounts. Read tools return figures already formatted; the only write tool
 * issues a credit and requires a person's approval before it runs.
 */
import { tool } from "ai";
import { z } from "zod";
import { formatCents, parseDollars } from "./billing/pricing.ts";
import { compareMonths, getDailyUsage } from "./billing/reports.ts";
import {
  BillingError,
  getCustomer,
  getInvoice,
  getUsageSummary,
  invoiceIdFor,
  issueCredit,
  listInvoices
} from "./billing/store.ts";

import { getPaymentCollection } from "./billing/payments.ts";

export const CREDIT_APPROVER = "support (demo UI)";

const month = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
  .describe("Billing month as YYYY-MM, e.g. 2026-09");

const meter = z
  .enum(["workers_requests", "ai_neurons"])
  .describe("workers_requests (Workers requests) or ai_neurons (Workers AI)");

const count = (n: number) => n.toLocaleString("en-US");
const money = (cents: number | null) =>
  cents === null ? null : formatCents(cents);

/** Expected billing errors go back to the model as data it can explain. */
async function answer<T>(fn: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BillingError) return { error: error.message };
    throw error;
  }
}

export function createBillingTools(db: D1Database, customerId: string) {
  return {
    getAccountOverview: tool({
      description:
        "Get the customer's plan, current balance owed, and list of invoices with totals and credits. Call this first to see which months are invoiced.",
      inputSchema: z.object({}),
      execute: () =>
        answer(async () => {
          const [customer, invoices] = await Promise.all([
            getCustomer(db, customerId),
            listInvoices(db, customerId)
          ]);
          return {
            customer: customer.name,
            plan: customer.planName,
            balanceOwed: formatCents(customer.balanceCents),
            invoices: invoices.map((i) => ({
              month: i.periodStart.slice(0, 7),
              status: i.status,
              total: money(i.totalCents),
              credited: formatCents(i.creditedCents)
            }))
          };
        })
    }),

    getInvoice: tool({
      description:
        "Get one month's invoice: every line item with its amount, credits issued, and how much can still be credited.",
      inputSchema: z.object({ month }),
      execute: ({ month }) =>
        answer(async () => {
          const invoice = await getInvoice(db, invoiceIdFor(customerId, month));
          const payment =
            invoice.status === "finalized"
              ? await getPaymentCollection(db, invoice.id)
              : null;
          return {
            month,
            status: invoice.status,
            lines: invoice.lines.map((l) => ({
              description: l.description,
              amount: formatCents(l.amountCents)
            })),
            total: money(invoice.totalCents),
            credits: invoice.credits.map((c) => ({
              amount: formatCents(c.amountCents),
              reason: c.reason
            })),
            stillCreditable:
              payment === null ? null : formatCents(payment.creditableCents)
          };
        })
    }),

    getPaymentState: tool({
      description:
        "Read this customer's finalized invoice payment state, bounded attempt budget, correlation IDs and durable timeline. Financial state is authoritative even after a Workflow completes. Reserved money is unresolved, not paid or available for credit. Read only: use the local demo UI for collection, card updates or reconciliation; never infer payment from Workflow completion.",
      inputSchema: z.object({ month }),
      execute: ({ month }) =>
        answer(async () => {
          const payment = await getPaymentCollection(
            db,
            invoiceIdFor(customerId, month)
          );
          return {
            month,
            invoiceId: payment.invoiceId,
            status: payment.status,
            total: formatCents(payment.totalCents),
            credited: formatCents(payment.creditedCents),
            paid: formatCents(payment.paidCents),
            reserved: formatCents(payment.reservedCents),
            due: formatCents(payment.balanceCents),
            stillCreditable: formatCents(payment.creditableCents),
            attemptsUsed: payment.attemptsUsed,
            attemptsRemaining: payment.attemptsRemaining,
            workflowId: payment.workflowId,
            hasConflict: Boolean(payment.hasConflict),
            attempts: payment.attempts.map(({ amountCents, ...attempt }) => ({
              ...attempt,
              amount: formatCents(amountCents)
            })),
            timeline: payment.timeline
          };
        })
    }),

    getUsage: tool({
      description:
        "Get total usage per meter for one month (works for the current, uninvoiced month too).",
      inputSchema: z.object({ month }),
      execute: ({ month }) =>
        answer(async () => {
          const usage = await getUsageSummary(db, customerId, month);
          return {
            month,
            meters: usage.meters.map((m) => ({
              meter: m.name,
              quantity: `${count(m.quantity)} ${m.unit}`
            }))
          };
        })
    }),

    compareMonths: tool({
      description:
        "Compare usage and invoice totals between two months, with precomputed changes. Use this to explain why a bill went up or down instead of calculating differences yourself.",
      inputSchema: z.object({ previousMonth: month, currentMonth: month }),
      execute: ({ previousMonth, currentMonth }) =>
        answer(async () => {
          const result = await compareMonths(
            db,
            customerId,
            previousMonth,
            currentMonth
          );
          const { invoiceTotals } = result;
          return {
            previousMonth,
            currentMonth,
            usage: result.meters.map((m) => ({
              meter: m.name,
              previous: `${count(m.previous)} ${m.unit}`,
              current: `${count(m.current)} ${m.unit}`,
              change: `${m.change >= 0 ? "+" : ""}${count(m.change)} ${m.unit}`,
              changePercent:
                m.changePercent === null ? "n/a" : `${m.changePercent}%`,
              usageCharges: {
                previous: money(m.previousChargeCents) ?? "not invoiced",
                current: money(m.currentChargeCents) ?? "not invoiced"
              }
            })),
            invoiceTotals: {
              previous: money(invoiceTotals.previous) ?? "not invoiced",
              current: money(invoiceTotals.current) ?? "not invoiced",
              change:
                invoiceTotals.changeCents === null
                  ? "n/a"
                  : `${invoiceTotals.changeCents >= 0 ? "+" : ""}${formatCents(invoiceTotals.changeCents)}`
            }
          };
        })
    }),

    getDailyUsage: tool({
      description:
        "Get day-by-day usage of one meter for a month, with the median, peak day, and unusual days (more than twice the median). Use this to find usage spikes.",
      inputSchema: z.object({ month, meter }),
      execute: ({ month, meter }) =>
        answer(async () => {
          const usage = await getDailyUsage(db, customerId, month, meter);
          return {
            month,
            meter,
            total: count(usage.total),
            medianPerDay: count(usage.medianPerDay),
            peak: usage.peak && {
              day: usage.peak.day,
              quantity: count(usage.peak.quantity)
            },
            unusualDays: usage.unusualDays.map((d) => ({
              day: d.day,
              quantity: count(d.quantity)
            })),
            days: usage.days.map((d) => `${d.day}: ${count(d.quantity)}`)
          };
        })
    }),

    issueCredit: tool({
      description:
        "Propose a credit on a finalized invoice, e.g. for an outage. A support person must approve it before it is applied. Never call this unless the user asks for a credit.",
      inputSchema: z.object({
        month,
        amount: z
          .string()
          .describe('Credit amount in US dollars, e.g. "10.00"'),
        reason: z
          .string()
          .min(3)
          .max(500)
          .describe("Why the credit is being issued")
      }),
      needsApproval: true,
      // The tool call id is the idempotency key: replaying an approval
      // cannot issue the credit twice.
      execute: async ({ month, amount, reason }, { toolCallId }) => {
        const amountCents = parseDollars(amount);
        if (amountCents === null || amountCents === 0) {
          throw new BillingError(
            "invalid",
            `"${amount}" is not a valid dollar amount`
          );
        }
        const { status, credit } = await issueCredit(db, {
          id: toolCallId,
          invoiceId: invoiceIdFor(customerId, month),
          amountCents,
          reason,
          approvedBy: CREDIT_APPROVER
        });
        return {
          result:
            status === "issued"
              ? "Approved by support and applied to the invoice"
              : "Already applied earlier; nothing changed",
          month,
          credited: formatCents(credit.amountCents),
          reason: credit.reason
        };
      }
    })
  };
}
