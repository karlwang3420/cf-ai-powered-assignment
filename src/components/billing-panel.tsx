import { useCallback, useEffect, useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CreditCardIcon
} from "@phosphor-icons/react";
import { formatCents } from "../billing/pricing";
import type { InvoiceDetail, InvoiceSummary } from "../billing/store";
import { api, monthLabel, type CustomerDetail } from "../client-api";
import type { PaymentCollection } from "../billing/payments";
import {
  CustomerPaymentLine,
  PaymentBadge,
  useCustomerPayments
} from "./payment-panel";

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <Text size="xs" variant="secondary" bold>
        {title.toUpperCase()}
      </Text>
      {children}
    </section>
  );
}

const count = (n: number) => n.toLocaleString("en-US");

// ── Invoices ──────────────────────────────────────────────────────────

function InvoiceRow({
  invoice,
  version,
  payment
}: {
  invoice: InvoiceSummary;
  version: number;
  payment?: PaymentCollection;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
    setError(null);
    api
      .invoice(invoice.id)
      .then((d) => !stale && setDetail(d))
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [open, invoice.id, version]);

  const month = invoice.periodStart.slice(0, 7);
  return (
    <div className="rounded-lg border border-kumo-line">
      <button
        type="button"
        className="w-full flex items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <CaretRightIcon
          size="0.75rem"
          className={`text-kumo-inactive transition-transform ${open ? "rotate-90" : ""}`}
        />
        <span className="flex-1 text-sm text-kumo-default">
          {monthLabel(month)}
        </span>
        {invoice.status === "draft" && <Badge variant="secondary">Draft</Badge>}
        {invoice.creditedCents > 0 && (
          <Badge variant="secondary">
            −{formatCents(invoice.creditedCents)}
          </Badge>
        )}
        <span className="text-sm font-medium tabular-nums text-kumo-default">
          {invoice.totalCents === null ? "—" : formatCents(invoice.totalCents)}
        </span>
        {payment && <PaymentBadge payment={payment} audience="customer" />}
      </button>
      {payment && <CustomerPaymentLine payment={payment} />}
      {open && (
        <div className="px-3 pb-3 space-y-1.5 border-t border-kumo-line pt-2">
          {error && (
            <Text size="xs" variant="secondary">
              {error}
            </Text>
          )}
          {detail?.lines.map((line) => (
            <div key={line.lineNo} className="flex gap-3 text-xs">
              <span className="flex-1 text-kumo-subtle">
                {line.description}
              </span>
              <span className="tabular-nums text-kumo-default">
                {formatCents(line.amountCents)}
              </span>
            </div>
          ))}
          {detail?.credits.map((credit) => (
            <div key={credit.id} className="flex gap-3 text-xs">
              <span className="flex-1 text-kumo-subtle">
                Credit: {credit.reason} ({credit.approvedBy})
              </span>
              <span className="tabular-nums text-kumo-success">
                −{formatCents(credit.amountCents)}
              </span>
            </div>
          ))}
          {detail && detail.lines.length === 0 && (
            <Text size="xs" variant="secondary">
              Draft: not priced yet.
            </Text>
          )}
        </div>
      )}
    </div>
  );
}

// ── Payment method ────────────────────────────────────────────────────

/** Simulated card on file. No card data exists; updating bumps a version. */
function PaymentMethod({
  customerId,
  version,
  onChanged
}: {
  customerId: string;
  version: number;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const update = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await api.updatePaymentMethod(customerId, version);
      setMessage("Card updated.");
      onChanged();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="flex items-center gap-2 text-sm text-kumo-default">
        <CreditCardIcon size="1rem" />
        Card on file · v{version}
      </span>
      <div className="flex items-center gap-2">
        {message && (
          <Text size="xs" variant="secondary">
            {message}
          </Text>
        )}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy}
          onClick={() => void update()}
        >
          Update card
        </Button>
      </div>
    </div>
  );
}

// ── Panel ─────────────────────────────────────────────────────────────

export function BillingPanel({
  customerId,
  refreshKey
}: {
  customerId: string;
  /** Changes when something outside the panel (e.g. an approved credit) may have changed billing data */
  refreshKey: number;
}) {
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  const payments = useCustomerPayments(
    customerId,
    refreshKey + reloads,
    reload
  );

  useEffect(() => {
    let stale = false;
    api
      .customer(customerId)
      .then((d) => {
        if (stale) return;
        setDetail(d);
        setError(null);
      })
      .catch((e: Error) => !stale && setError(e.message));
    return () => {
      stale = true;
    };
  }, [customerId, refreshKey, reloads]);

  if (error) {
    return (
      <div className="p-5 space-y-2">
        <Text size="sm" variant="secondary">
          Could not load billing data: {error}. Check local migrations; do not
          reset demo data.
        </Text>
        <Button variant="secondary" size="sm" onClick={reload}>
          Retry billing read
        </Button>
      </div>
    );
  }
  if (!detail || detail.customer.id !== customerId) {
    return (
      <div className="p-5">
        <Text size="sm" variant="secondary">
          Loading billing data…
        </Text>
      </div>
    );
  }

  const { customer, invoices, currentUsage } = detail;
  // The simulated card version is per customer; every collection carries it
  const methodVersion = payments.snapshot?.payments[0]?.methodVersion;
  return (
    <div className="p-5 space-y-6">
      <Surface className="rounded-xl ring ring-kumo-line p-4 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="text-base font-semibold text-kumo-default">
              {customer.name}
            </div>
            <Text size="xs" variant="secondary">
              {customer.email}
            </Text>
          </div>
          <Badge variant="secondary">{customer.planName} plan</Badge>
        </div>
        <div>
          <Text size="xs" variant="secondary">
            Balance owed
          </Text>
          <div className="text-2xl font-semibold tabular-nums text-kumo-default">
            {formatCents(customer.balanceCents)}
          </div>
        </div>
      </Surface>

      <Section title="Invoices">
        {invoices.length === 0 ? (
          <Text size="sm" variant="secondary">
            No invoices yet.
          </Text>
        ) : (
          <div className="space-y-2">
            {invoices.map((invoice) => (
              <InvoiceRow
                key={invoice.id}
                invoice={invoice}
                version={refreshKey + reloads}
                payment={payments.snapshot?.payments.find(
                  (p) => p.invoiceId === invoice.id
                )}
              />
            ))}
          </div>
        )}
        {payments.error && (
          <p role="alert" className="text-xs text-kumo-danger">
            Could not refresh payment status. Retrying automatically.
          </p>
        )}
      </Section>

      {methodVersion !== undefined && (
        <Section title="Payment method">
          <PaymentMethod
            customerId={customer.id}
            version={methodVersion}
            onChanged={reload}
          />
        </Section>
      )}

      <Section title={`${monthLabel(currentUsage.month)} so far`}>
        <div className="space-y-1">
          {currentUsage.meters.map((meter) => (
            <div key={meter.meterId} className="flex gap-3 text-sm">
              <span className="flex-1 text-kumo-subtle">{meter.name}</span>
              <span className="tabular-nums text-kumo-default">
                {count(meter.quantity)} {meter.unit}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Button
        variant="ghost"
        size="sm"
        icon={<ArrowsClockwiseIcon size="0.875rem" />}
        onClick={reload}
      >
        Refresh
      </Button>
    </div>
  );
}
