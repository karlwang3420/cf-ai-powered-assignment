import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Button, Surface, Text } from "@cloudflare/kumo";
import {
  ArrowsClockwiseIcon,
  CaretRightIcon,
  CheckCircleIcon,
  LightningIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { formatCents } from "../billing/pricing";
import type { InvoiceDetail, InvoiceSummary } from "../billing/store";
import { api, monthLabel, type CustomerDetail } from "../client-api";

const selectClass =
  "w-full px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";

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

// ── Invoice run (Workflow) ────────────────────────────────────────────

type RunState =
  | { phase: "idle" }
  | { phase: "running"; month: string; status: string }
  | { phase: "done"; month: string; message: string }
  | { phase: "failed"; month: string; message: string };

function InvoiceRunner({
  detail,
  onFinished
}: {
  detail: CustomerDetail;
  onFinished: () => void;
}) {
  const open = detail.months.filter((m) => m.status !== "finalized");
  const [chosen, setMonth] = useState("");
  // Fall back to the newest open month when the choice was just invoiced
  const month = open.some((m) => m.month === chosen)
    ? chosen
    : (open[0]?.month ?? "");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  const start = async () => {
    setRun({ phase: "running", month, status: "queued" });
    try {
      const { id } = await api.startInvoiceRun(detail.customer.id, month);
      // Poll the Workflow instance until it finishes
      for (let attempt = 0; attempt < 120 && !cancelled.current; attempt++) {
        const status = await api.invoiceRun(id);
        if (status.status === "complete") {
          const total = status.output?.totalCents ?? null;
          setRun({
            phase: "done",
            month,
            message: `Invoice finalized: ${total === null ? "-" : formatCents(total)}`
          });
          onFinished();
          return;
        }
        if (status.status === "errored" || status.status === "terminated") {
          setRun({
            phase: "failed",
            month,
            message: status.error?.message ?? "Workflow failed"
          });
          onFinished();
          return;
        }
        setRun({ phase: "running", month, status: status.status });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      setRun({ phase: "failed", month, message: (error as Error).message });
    }
  };

  const allInvoiced = open.length === 0 && run.phase !== "running";

  return (
    <div className="space-y-2">
      {allInvoiced ? (
        <Text size="sm" variant="secondary">
          Every ended month is invoiced.
        </Text>
      ) : (
        <div className="flex gap-2">
          <select
            className={selectClass}
            value={month}
            onChange={(e) => setMonth(e.target.value)}
            disabled={run.phase === "running"}
            aria-label="Month to invoice"
          >
            {open.map((m) => (
              <option key={m.month} value={m.month}>
                {monthLabel(m.month)}
                {m.status === "draft" ? " (draft)" : ""}
              </option>
            ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            icon={<LightningIcon size={14} />}
            disabled={!month || run.phase === "running"}
            onClick={start}
          >
            Run invoice
          </Button>
        </div>
      )}
      {run.phase === "running" && (
        <Text size="xs" variant="secondary">
          Workflow {run.status} for {monthLabel(run.month)}…
        </Text>
      )}
      {run.phase === "done" && (
        <div className="flex items-center gap-1.5 text-kumo-success">
          <CheckCircleIcon size={14} />
          <Text size="xs">
            {monthLabel(run.month)}: {run.message}
          </Text>
        </div>
      )}
      {run.phase === "failed" && (
        <div className="flex items-center gap-1.5 text-kumo-danger">
          <WarningCircleIcon size={14} />
          <Text size="xs">
            {monthLabel(run.month)}: {run.message}
          </Text>
        </div>
      )}
      <Text size="xs" variant="secondary">
        Runs a Cloudflare Workflow: open draft → finalize → reconcile ledger.
      </Text>
    </div>
  );
}

// ── Invoices ──────────────────────────────────────────────────────────

function InvoiceRow({
  invoice,
  version
}: {
  invoice: InvoiceSummary;
  version: number;
}) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<InvoiceDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let stale = false;
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
          size={12}
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
      </button>
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
      <div className="p-5">
        <Text size="sm" variant="secondary">
          Could not load billing data: {error}. Did you run{" "}
          <code>npm run db:setup</code>?
        </Text>
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

      <Section title="Run invoice">
        <InvoiceRunner key={customer.id} detail={detail} onFinished={reload} />
      </Section>

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
              />
            ))}
          </div>
        )}
      </Section>

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
        icon={<ArrowsClockwiseIcon size={14} />}
        onClick={reload}
      >
        Refresh
      </Button>
    </div>
  );
}
