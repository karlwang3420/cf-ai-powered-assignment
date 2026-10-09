import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Tabs } from "@cloudflare/kumo";
import {
  ArrowCounterClockwiseIcon,
  ArrowSquareOutIcon,
  ArrowsClockwiseIcon,
  PlayIcon,
  XIcon
} from "@phosphor-icons/react";
import type { PaymentCollection, PaymentDetail } from "../billing/payments";
import { formatCents } from "../billing/pricing";
import {
  api,
  monthLabel,
  type PaymentReconciliation,
  type PaymentRun
} from "../client-api";
import type { ProcessorScenario } from "../payments/protocol";
import { PaymentBadge } from "./payment-panel";
import {
  canCollectPayment,
  collectBlockedReason,
  dueCents,
  invoiceMonth,
  paymentLabel,
  paymentNextStep,
  paymentPollDelay,
  pollPaymentRead
} from "./payment-state";

const scenarios: { label: string; values: ProcessorScenario[] }[] = [
  { label: "Default (success)", values: [] },
  { label: "Soft decline → success", values: ["soft_decline", "success"] },
  {
    label: "Hard decline → success (update card)",
    values: ["hard_decline", "success"]
  },
  { label: "Outage → same-key recovery", values: ["outage"] },
  { label: "Success with lost response", values: ["lost_response"] },
  { label: "Pending → webhook", values: ["pending"] },
  { label: "Lost webhook → status lookup", values: ["lost_webhook"] },
  { label: "Duplicate webhook", values: ["duplicate_webhook"] },
  {
    label: "Unresolved pending → manual review",
    values: ["unresolved_pending"]
  },
  {
    label: "Four soft declines (budget exhausted)",
    values: Array<ProcessorScenario>(4).fill("soft_decline")
  },
  {
    label: "Four hard declines (four-attempt limit)",
    values: Array<ProcessorScenario>(4).fill("hard_decline")
  }
];

const queueLabel = (queue: ProcessorScenario[]) =>
  queue.length ? queue.map(paymentLabel).join(" → ") : "default success";

/** Dropdown option matching the processor's current queue, or -1. */
const queueIndex = (queue: ProcessorScenario[] | null) =>
  queue === null
    ? -1
    : scenarios.findIndex(
        (s) => JSON.stringify(s.values) === JSON.stringify(queue)
      );

// Seconds are enough to read; the list order comes from millisecond
// timestamps plus insert order on the server, so it is stable regardless.
const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour12: false });

export function AttemptDots({ payment }: { payment: PaymentCollection }) {
  const used = payment.attemptsUsed;
  return (
    <span
      className="inline-flex gap-1"
      title={`${used} of 4 attempts used`}
      aria-label={`${used} of 4 attempts used`}
    >
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`size-2 rounded-full ${
            i < used
              ? payment.attemptsRemaining === 0
                ? "bg-kumo-danger"
                : "bg-kumo-contrast"
              : "ring-1 ring-inset ring-kumo-line"
          }`}
        />
      ))}
    </span>
  );
}

/** credit + paid + held + due = total, drawn as one stacked bar. */
function MoneyBar({ payment }: { payment: PaymentCollection }) {
  const parts = [
    ["Credit", payment.creditedCents, "bg-kumo-info"],
    ["Paid", payment.paidCents, "bg-kumo-success"],
    ["Held", payment.reservedCents, "bg-kumo-warning"],
    ["Due", dueCents(payment), "bg-kumo-contrast"]
  ] as const;
  const total = Math.max(payment.totalCents, 1);
  return (
    <div className="space-y-2">
      <div className="flex h-2 overflow-hidden rounded-full bg-kumo-recessed">
        {parts.map(([label, cents, color]) =>
          cents > 0 ? (
            <div
              key={label}
              className={color}
              style={{ width: `${(cents / total) * 100}%` }}
            />
          ) : null
        )}
      </div>
      <dl className="grid grid-cols-4 gap-2 text-xs">
        {parts.map(([label, cents, color]) => (
          <div key={label}>
            <dt className="flex items-center gap-1.5 text-kumo-subtle">
              <span className={`size-2 rounded-full ${color}`} />
              {label}
            </dt>
            <dd className="font-semibold tabular-nums text-kumo-default">
              {formatCents(cents)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function Row({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid grid-cols-[8rem_1fr] gap-2 py-1 border-b border-kumo-line last:border-0">
      <dt className="text-kumo-subtle">{label}</dt>
      <dd className="min-w-0 break-all text-kumo-default">{children}</dd>
    </div>
  );
}

function ActivityTab({ detail }: { detail: PaymentDetail | null }) {
  if (!detail) return <p className="text-kumo-subtle">Loading…</p>;
  if (!detail.timeline.length)
    return <p className="text-kumo-subtle">No payment events yet.</p>;
  return (
    <ol className="space-y-2">
      {detail.timeline.map((event) => (
        <li key={event.id} className="grid grid-cols-[4.5rem_1fr] gap-2">
          <time
            className="tabular-nums text-kumo-subtle"
            dateTime={event.createdAt}
          >
            {time(event.createdAt)}
          </time>
          <div className="min-w-0">
            <span className="text-kumo-default">
              {paymentLabel(event.kind)}
              {event.attemptNumber !== null
                ? ` · attempt ${event.attemptNumber}`
                : ""}
            </span>
            {event.message && event.message !== event.kind && (
              <p className="truncate text-kumo-subtle" title={event.message}>
                {event.message}
              </p>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}

function ResetToUnpaid({
  disabled,
  onReset
}: {
  disabled: boolean;
  onReset: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirming)
    return (
      <Button
        size="sm"
        variant="secondary"
        icon={<ArrowCounterClockwiseIcon size="0.875rem" />}
        disabled={disabled}
        onClick={() => setConfirming(true)}
      >
        Reset to unpaid
      </Button>
    );
  return (
    <div className="rounded-lg border border-kumo-danger p-3 space-y-2">
      <p className="text-kumo-default">
        Deletes this invoice's payments, attempts, ledger postings, webhooks and
        processor records, then reopens it with 4 attempts. Credits stay.
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={disabled}
          onClick={() => {
            setConfirming(false);
            onReset();
          }}
        >
          Reset
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setConfirming(false)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DebugTab({
  payment,
  detail,
  run,
  disabled,
  onReset
}: {
  payment: PaymentCollection;
  detail: PaymentDetail | null;
  run: PaymentRun | null;
  disabled: boolean;
  onReset: () => void;
}) {
  return (
    <div className="space-y-4">
      <ResetToUnpaid disabled={disabled} onReset={onReset} />
      <dl>
        <Row label="Invoice">
          <code>{payment.invoiceId}</code>
        </Row>
        <Row label="Workflow">
          <code>{payment.workflowId ?? "not started"}</code>
        </Row>
        <Row label="Workflow run">
          {run ? paymentLabel(run.status) : "loading…"}
        </Row>
        {run?.error && (
          <Row label="Workflow error">
            <span className="text-kumo-danger">{run.error.message}</span>
          </Row>
        )}
        <Row label="Generation">{payment.generation}</Row>
        <Row label="Owner">
          <code>{payment.ownerId ?? "none"}</code> ·{" "}
          {payment.ownerActive ? "active" : "released"}
        </Row>
        <Row label="Card version">{payment.methodVersion}</Row>
      </dl>
      {detail?.attempts.map((attempt) => (
        <dl key={attempt.id}>
          <Row label={`Attempt ${attempt.attemptNumber}`}>
            {paymentLabel(attempt.state)}
            {attempt.declineType ? ` (${attempt.declineType})` : ""} ·{" "}
            {formatCents(attempt.amountCents)}
            {attempt.conflicted ? (
              <span className="text-kumo-danger"> · conflicting</span>
            ) : null}
          </Row>
          <Row label="Idempotency key">
            <code>{attempt.idempotencyKey}</code>
          </Row>
          <Row label="Processor ID">
            <code>{attempt.processorPaymentId ?? "not confirmed"}</code>
          </Row>
          <Row label="Gen / card">
            {attempt.generation} / v{attempt.methodVersion}
          </Row>
        </dl>
      ))}
      <a
        href="/cdn-cgi/local/explorer"
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1 underline text-kumo-default"
      >
        Workflow Explorer <ArrowSquareOutIcon size="0.75rem" />
      </a>
    </div>
  );
}

function ReconciliationSummary({ result }: { result: PaymentReconciliation }) {
  const problems = [
    ...result.inbox
      .filter((e) => !e.applied)
      .map((e) => `event ${e.eventId}: unapplied`),
    ...result.checks
      .filter((c) => ["unresolved", "error", "conflict"].includes(c.result))
      .map((c) => `attempt ${c.attemptId}: ${c.result}`),
    ...result.issues.map((issue) => JSON.stringify(issue))
  ];
  return (
    <div className="text-xs" aria-live="polite">
      <p className="text-kumo-subtle">
        Reconciled {result.inbox.length} events · {result.checks.length} checks
        · {result.issues.length} ledger issues
      </p>
      {problems.map((p) => (
        <p key={p} className="break-all text-kumo-danger">
          {p}
        </p>
      ))}
    </div>
  );
}

export function PaymentDialog({
  payment,
  customerName,
  onClose,
  onChanged
}: {
  payment: PaymentCollection;
  customerName: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState("activity");
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [run, setRun] = useState<PaymentRun | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const [result, setResult] = useState<PaymentReconciliation | null>(null);
  const [queue, setQueue] = useState<ProcessorScenario[] | null>(null);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const acting = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(
    () =>
      pollPaymentRead(
        async () => ({
          detail: await api.payment(payment.invoiceId),
          run: await api.paymentRun(payment.invoiceId)
        }),
        (next) => {
          setDetail(next.detail);
          setRun(next.run);
          setReadError(null);
        },
        (error) => setReadError(error.message),
        (next) => paymentPollDelay([next.detail])
      ),
    [
      payment.invoiceId,
      payment.updatedAt,
      payment.methodVersion,
      payment.paidCents,
      payment.creditedCents,
      reload
    ]
  );

  // The processor's remaining queue is the source of truth; attempts consume it.
  useEffect(() => {
    let stale = false;
    api
      .paymentProcessor(payment.invoiceId)
      .then((r) => !stale && setQueue(r.scenarios))
      .catch(() => !stale && setQueue(null));
    return () => {
      stale = true;
    };
  }, [payment.invoiceId, payment.attemptsUsed, payment.status, reload]);

  const act = async (label: string, action: () => Promise<string>) => {
    if (acting.current) return;
    acting.current = true;
    setBusy(label);
    setActionError(null);
    setMessage("");
    setResult(null);
    try {
      const next = await action();
      if (alive.current) setMessage(next);
    } catch (error) {
      if (alive.current) setActionError((error as Error).message);
    } finally {
      acting.current = false;
      if (alive.current) {
        setBusy(null);
        setReload((n) => n + 1);
        onChanged();
      }
    }
  };
  const reconcile = (resume: boolean) =>
    act("Reconciling", async () => {
      const r = await api.reconcilePayments(payment.invoiceId, resume);
      if (alive.current) setResult(r);
      return resume ? "Reconciled; collection resumed if allowed." : "";
    });

  const disabled = Boolean(busy || readError);
  const blocked = collectBlockedReason(payment);
  const month = monthLabel(invoiceMonth(payment.invoiceId));

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog size="lg" className="p-0">
        <div className="max-h-[85vh] overflow-y-auto">
          <div className="p-5 space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Dialog.Title className="text-base font-semibold">
                  {customerName} · {month}
                </Dialog.Title>
                <Dialog.Description className="text-xs text-kumo-subtle break-all">
                  {payment.invoiceId} · total {formatCents(payment.totalCents)}
                </Dialog.Description>
              </div>
              <Dialog.Close
                render={(props) => (
                  <Button
                    {...props}
                    variant="ghost"
                    shape="square"
                    size="sm"
                    icon={<XIcon size="1rem" />}
                    aria-label="Close"
                  />
                )}
              />
            </div>

            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <PaymentBadge payment={payment} />
                <p className="text-sm text-kumo-default">
                  {paymentNextStep(payment)}
                </p>
              </div>
              <div className="text-right space-y-1">
                <AttemptDots payment={payment} />
                <p className="text-xs text-kumo-subtle tabular-nums">
                  {payment.attemptsUsed} of 4 used
                </p>
              </div>
            </div>

            <MoneyBar payment={payment} />

            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  icon={<PlayIcon size="0.875rem" />}
                  disabled={disabled || !canCollectPayment(payment)}
                  title={blocked ?? undefined}
                  onClick={() =>
                    void act("Collecting", async () => {
                      const r = await api.collectPayment(payment.invoiceId);
                      return r.started
                        ? "Collection started."
                        : "Existing collection recovered; no new charge.";
                    })
                  }
                >
                  Collect
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<ArrowsClockwiseIcon size="0.875rem" />}
                  disabled={disabled}
                  onClick={() => void reconcile(false)}
                >
                  Reconcile
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={disabled}
                  title="Reconcile, then continue bounded collection; may charge the remaining balance"
                  onClick={() => void reconcile(true)}
                >
                  Reconcile + resume
                </Button>
              </div>
              {queue && queue.length > 0 && (
                <p className="text-xs text-kumo-warning">
                  Mock: next outcome {queueLabel(queue)}
                </p>
              )}
              {blocked && payment.balanceCents > 0 && (
                <p className="text-xs text-kumo-subtle">
                  Collect blocked: {blocked}
                </p>
              )}
              {busy && (
                <output className="block text-xs text-kumo-subtle">
                  {busy}…
                </output>
              )}
              {message && (
                <output className="block text-xs text-kumo-subtle">
                  {message}
                </output>
              )}
              {(actionError || readError) && (
                <p role="alert" className="text-xs text-kumo-danger">
                  {actionError ?? `Payment data may be stale: ${readError}`}
                </p>
              )}
              {result && <ReconciliationSummary result={result} />}
            </div>
          </div>

          <div className="border-t border-kumo-line p-5 space-y-4">
            <Tabs
              variant="underline"
              size="sm"
              value={tab}
              onValueChange={setTab}
              tabs={[
                { value: "activity", label: "Activity" },
                { value: "mock", label: "Mock controls" },
                { value: "debug", label: "Debug" }
              ]}
            />
            <div className="text-xs">
              {tab === "activity" && <ActivityTab detail={detail} />}
              {tab === "mock" && (
                <div className="space-y-4">
                  <label className="block space-y-1.5">
                    <span className="block text-kumo-subtle">
                      Processor outcome for the next charge (applies
                      immediately)
                    </span>
                    <select
                      aria-label="Mock scenario"
                      className="w-full min-w-0 px-2 py-1.5 rounded-lg border border-kumo-line bg-kumo-base text-kumo-default"
                      value={queueIndex(queue)}
                      disabled={
                        disabled ||
                        queue === null ||
                        !canCollectPayment(payment)
                      }
                      onChange={(e) => {
                        const values = scenarios[Number(e.target.value)].values;
                        void act("Saving scenario", async () => {
                          const r = await api.paymentScenarios(
                            payment.invoiceId,
                            values
                          );
                          if (alive.current) setQueue(r.scenarios);
                          return `Mock queue set: ${queueLabel(r.scenarios)}`;
                        });
                      }}
                    >
                      {queueIndex(queue) === -1 && (
                        <option value={-1}>
                          {queue === null
                            ? "Loading…"
                            : `Remaining: ${queueLabel(queue)}`}
                        </option>
                      )}
                      {scenarios.map((s, i) => (
                        <option key={s.label} value={i}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    {!canCollectPayment(payment) && (
                      <span className="block text-kumo-subtle">
                        {payment.reservedCents > 0
                          ? "Locked while a charge is unresolved. Settle it below."
                          : "Only for invoices that can still be collected."}
                      </span>
                    )}
                  </label>
                  {payment.reservedCents > 0 && (
                    <div className="space-y-1.5">
                      <p className="text-kumo-subtle">
                        Settle pending charge ·{" "}
                        {formatCents(payment.reservedCents)} · processor sends
                        its webhook
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {(
                          [
                            ["succeeded", "Succeeds"],
                            ["soft_decline", "Soft decline"],
                            ["hard_decline", "Hard decline"]
                          ] as const
                        ).map(([outcome, label]) => (
                          <Button
                            key={outcome}
                            size="sm"
                            variant="secondary"
                            disabled={disabled}
                            onClick={() =>
                              void act("Settling", async () => {
                                await api.settlePendingCharge(
                                  payment.invoiceId,
                                  outcome
                                );
                                return `Processor settled the charge: ${label.toLowerCase()}. Waiting for its webhook.`;
                              })
                            }
                          >
                            {label}
                          </Button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-kumo-subtle">
                      Simulated card · version {payment.methodVersion}
                    </p>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={disabled}
                      onClick={() =>
                        void act("Updating card", async () => {
                          const r = await api.updatePaymentMethod(
                            payment.customerId,
                            payment.methodVersion
                          );
                          return `Card updated to version ${r.methodVersion}.`;
                        })
                      }
                    >
                      Simulate card update
                    </Button>
                  </div>
                </div>
              )}
              {tab === "debug" && (
                <DebugTab
                  payment={payment}
                  detail={detail}
                  run={run}
                  disabled={Boolean(busy)}
                  onReset={() =>
                    void act("Resetting", async () => {
                      await api.debugResetPayment(payment.invoiceId);
                      return "Reset to unpaid. Payment history cleared.";
                    })
                  }
                />
              )}
            </div>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}
