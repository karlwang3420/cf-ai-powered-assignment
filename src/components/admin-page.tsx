import { useCallback, useEffect, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, WarningIcon } from "@phosphor-icons/react";
import type { PaymentCollection, PaymentInboxEvent } from "../billing/payments";
import { formatCents } from "../billing/pricing";
import type { CustomerSummary } from "../billing/store";
import { api, monthLabel } from "../client-api";
import { InvoiceRunner, selectClass } from "./invoice-runner";
import { AttemptDots, PaymentDialog } from "./payment-dialog";
import { PaymentBadge } from "./payment-panel";
import {
  dueCents,
  invoiceMonth,
  paymentNeedsAttention,
  paymentPollDelay,
  pollPaymentRead
} from "./payment-state";

type Filter = "all" | "attention";

function Tile({
  label,
  value,
  alert,
  children
}: {
  label: string;
  value: string;
  alert: boolean;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-lg border p-3 bg-kumo-base ${alert ? "border-kumo-danger" : "border-kumo-line"}`}
    >
      <Text size="xs" variant="secondary">
        {label}
      </Text>
      <div className="flex items-end justify-between gap-2">
        <span
          className={`text-xl font-semibold tabular-nums ${alert ? "text-kumo-danger" : "text-kumo-default"}`}
        >
          {value}
        </span>
        {children}
      </div>
    </div>
  );
}

export function AdminPage({ customers }: { customers: CustomerSummary[] }) {
  const [payments, setPayments] = useState<PaymentCollection[] | null>(null);
  const [inbox, setInbox] = useState<PaymentInboxEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [customerFilter, setCustomerFilter] = useState("all");
  const [reloads, setReloads] = useState(0);
  const [reconciling, setReconciling] = useState(false);
  const reload = useCallback(() => setReloads((n) => n + 1), []);

  useEffect(
    () =>
      pollPaymentRead(
        async () => ({
          payments: await api.allPayments(),
          inbox: await api.allPaymentInbox()
        }),
        (next) => {
          setPayments(next.payments);
          setInbox(next.inbox);
          setError(null);
        },
        (e) => setError(e.message),
        (next) => paymentPollDelay(next.payments, next.inbox)
      ),
    [reloads]
  );

  const names = new Map(customers.map((c) => [c.id, c.name]));
  const all = payments ?? [];
  const count = (status: PaymentCollection["status"]) =>
    all.filter((p) => p.status === status).length;
  const held = all.reduce((sum, p) => sum + p.reservedCents, 0);
  const rows = all
    .filter(
      (p) =>
        (filter === "all" || paymentNeedsAttention(p)) &&
        (customerFilter === "all" || p.customerId === customerFilter)
    )
    .sort(
      (a, b) =>
        Number(paymentNeedsAttention(b)) - Number(paymentNeedsAttention(a)) ||
        invoiceMonth(b.invoiceId).localeCompare(invoiceMonth(a.invoiceId)) ||
        (names.get(a.customerId) ?? "").localeCompare(
          names.get(b.customerId) ?? ""
        )
    );
  const open = all.find((p) => p.invoiceId === selected);

  const reconcileAll = async () => {
    setReconciling(true);
    try {
      await api.reconcilePayments();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReconciling(false);
      reload();
    }
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto p-5 space-y-6">
        <section className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <Tile
            label="Needs review"
            value={String(count("needs_review"))}
            alert={count("needs_review") > 0}
          />
          <Tile
            label="Awaiting card"
            value={String(count("action_required"))}
            alert={false}
          />
          <Tile
            label="Past due"
            value={String(count("past_due"))}
            alert={count("past_due") > 0}
          />
          <Tile label="Held" value={formatCents(held)} alert={false} />
          <Tile
            label="Unapplied webhooks"
            value={String(inbox.length)}
            alert={inbox.length > 0}
          >
            <Button
              size="sm"
              variant="secondary"
              icon={<ArrowsClockwiseIcon size="0.875rem" />}
              disabled={reconciling}
              onClick={() => void reconcileAll()}
            >
              {reconciling ? "Reconciling…" : "Reconcile all"}
            </Button>
          </Tile>
        </section>

        <section className="space-y-2">
          <Text size="xs" variant="secondary" bold>
            RUN INVOICE
          </Text>
          {customers.length > 0 && (
            <InvoiceRunner
              customers={customers}
              onFinished={(invoiceId) => {
                reload();
                // Open it so a mock outcome can be chosen before Collect
                if (invoiceId) setSelected(invoiceId);
              }}
            />
          )}
        </section>

        <section className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <Text size="xs" variant="secondary" bold>
              COLLECTIONS
            </Text>
            <div className="flex gap-2">
              <select
                className={`${selectClass} w-40`}
                value={filter}
                onChange={(e) => setFilter(e.target.value as Filter)}
                aria-label="Status filter"
              >
                <option value="all">All statuses</option>
                <option value="attention">Needs attention</option>
              </select>
              <select
                className={`${selectClass} w-44`}
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                aria-label="Customer filter"
              >
                <option value="all">All customers</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-xs text-kumo-danger">
              Could not refresh payments: {error}. Retrying automatically.
            </p>
          )}
          <div className="rounded-lg border border-kumo-line bg-kumo-base overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-kumo-subtle border-b border-kumo-line">
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Invoice</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right hidden sm:table-cell">
                    Paid
                  </th>
                  <th className="px-3 py-2 font-medium text-right hidden sm:table-cell">
                    Held
                  </th>
                  <th className="px-3 py-2 font-medium text-right">Due</th>
                  <th className="px-3 py-2 font-medium hidden sm:table-cell">
                    Attempts
                  </th>
                </tr>
              </thead>
              <tbody>
                {!payments && !error && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-kumo-subtle">
                      Loading…
                    </td>
                  </tr>
                )}
                {payments && rows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-4 text-kumo-subtle">
                      {filter === "attention"
                        ? "Nothing needs attention."
                        : "No finalized invoices yet."}
                    </td>
                  </tr>
                )}
                {rows.map((p) => (
                  <tr
                    key={p.invoiceId}
                    className="border-b border-kumo-line last:border-0 cursor-pointer hover:bg-kumo-elevated"
                    onClick={() => setSelected(p.invoiceId)}
                  >
                    <td className="px-3 py-2 text-kumo-default">
                      {names.get(p.customerId) ?? p.customerId}
                    </td>
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        className="text-kumo-default underline-offset-2 hover:underline whitespace-nowrap"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelected(p.invoiceId);
                        }}
                      >
                        {monthLabel(invoiceMonth(p.invoiceId))}
                      </button>
                    </td>
                    <td className="px-3 py-2">
                      <span className="inline-flex items-center gap-1.5">
                        <PaymentBadge payment={p} />
                        {paymentNeedsAttention(p) && (
                          <WarningIcon
                            size="0.875rem"
                            className="text-kumo-danger"
                            aria-label="Needs attention"
                          />
                        )}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">
                      {formatCents(p.paidCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums hidden sm:table-cell">
                      {formatCents(p.reservedCents)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatCents(dueCents(p))}
                    </td>
                    <td className="px-3 py-2 hidden sm:table-cell">
                      <AttemptDots payment={p} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
      {open && (
        <PaymentDialog
          key={open.invoiceId}
          payment={open}
          customerName={names.get(open.customerId) ?? open.customerId}
          onClose={() => setSelected(null)}
          onChanged={reload}
        />
      )}
    </div>
  );
}
