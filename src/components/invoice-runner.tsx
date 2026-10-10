import { useEffect, useRef, useState } from "react";
import { Button, Text } from "@cloudflare/kumo";
import {
  CheckCircleIcon,
  LightningIcon,
  WarningCircleIcon
} from "@phosphor-icons/react";
import { formatCents } from "../billing/pricing";
import type { CustomerSummary } from "../billing/store";
import { api, monthLabel, type CustomerDetail } from "../client-api";

export const selectClass =
  "w-full min-w-0 px-3 py-1.5 text-sm rounded-lg border border-kumo-line bg-kumo-base text-kumo-default focus:outline-none focus:ring-1 focus:ring-kumo-ring";

type RunState =
  | { phase: "idle" }
  | { phase: "running"; month: string; status: string }
  | { phase: "done"; month: string; message: string }
  | { phase: "failed"; month: string; message: string };

/** Admin control: pick a customer and an ended month, run the invoice Workflow. */
export function InvoiceRunner({
  customers,
  onFinished
}: {
  customers: CustomerSummary[];
  /** Called with the finalized invoice's ID when the run completes. */
  onFinished: (invoiceId?: string) => void;
}) {
  const [customerId, setCustomerId] = useState(customers[0]?.id ?? "");
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [reloads, setReloads] = useState(0);
  const [chosen, setMonth] = useState("");
  const [run, setRun] = useState<RunState>({ phase: "idle" });
  const cancelled = useRef(false);

  useEffect(() => {
    cancelled.current = false;
    return () => {
      cancelled.current = true;
    };
  }, []);

  useEffect(() => {
    if (!customerId) return;
    let stale = false;
    api
      .customer(customerId)
      .then((d) => !stale && setDetail(d))
      .catch(
        (e: Error) =>
          !stale && setRun({ phase: "failed", month: "", message: e.message })
      );
    return () => {
      stale = true;
    };
  }, [customerId, reloads]);

  const open =
    detail?.customer.id === customerId
      ? detail.months.filter((m) => m.status !== "finalized")
      : [];
  // Fall back to the newest open month when the choice was just invoiced
  const month = open.some((m) => m.month === chosen)
    ? chosen
    : (open[0]?.month ?? "");

  const start = async () => {
    setRun({ phase: "running", month, status: "queued" });
    try {
      const { id } = await api.startInvoiceRun(customerId, month);
      if (cancelled.current) return;
      // Poll the Workflow instance until it finishes
      for (let attempt = 0; attempt < 120 && !cancelled.current; attempt++) {
        const status = await api.invoiceRun(id);
        if (cancelled.current) return;
        if (status.status === "complete") {
          const total = status.output?.totalCents ?? null;
          setRun({
            phase: "done",
            month,
            message: `finalized ${total === null ? "-" : formatCents(total)}, not collected yet`
          });
          setReloads((n) => n + 1);
          onFinished(status.output?.invoiceId);
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
      if (!cancelled.current)
        setRun({
          phase: "failed",
          month,
          message:
            "stopped waiting after 120 checks; the Workflow may still be running"
        });
    } catch (error) {
      if (cancelled.current) return;
      setRun({ phase: "failed", month, message: (error as Error).message });
    }
  };

  const running = run.phase === "running";
  const label = (m: string) => (m ? `${monthLabel(m)}: ` : "");
  return (
    <div className="space-y-2">
      <div className="flex flex-col sm:flex-row gap-2">
        <select
          className={`${selectClass} sm:w-56`}
          value={customerId}
          onChange={(e) => {
            setCustomerId(e.target.value);
            setRun({ phase: "idle" });
          }}
          disabled={running}
          aria-label="Customer to invoice"
        >
          {customers.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          className={`${selectClass} sm:w-48`}
          value={month}
          onChange={(e) => setMonth(e.target.value)}
          disabled={running || open.length === 0}
          aria-label="Month to invoice"
        >
          {open.length === 0 && <option value="">All months invoiced</option>}
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
          icon={<LightningIcon size="0.875rem" />}
          disabled={!month || running}
          onClick={start}
        >
          Run invoice
        </Button>
      </div>
      {run.phase === "running" && (
        <Text size="xs" variant="secondary">
          {label(run.month)}Workflow {run.status}…
        </Text>
      )}
      {run.phase === "done" && (
        <div className="flex items-center gap-1.5 text-kumo-success">
          <CheckCircleIcon size="0.875rem" />
          <Text size="xs">
            {label(run.month)}
            {run.message}
          </Text>
        </div>
      )}
      {run.phase === "failed" && (
        <div className="flex items-center gap-1.5 text-kumo-danger">
          <WarningCircleIcon size="0.875rem" />
          <Text size="xs">
            {label(run.month)}
            {run.message}
          </Text>
        </div>
      )}
    </div>
  );
}
