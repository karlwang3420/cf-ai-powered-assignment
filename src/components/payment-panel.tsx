import { useEffect, useRef, useState } from "react";
import { Badge, Button, Text } from "@cloudflare/kumo";
import type {
  PaymentCollection,
  PaymentDetail,
  PaymentInboxEvent
} from "../billing/payments";
import { formatCents } from "../billing/pricing";
import {
  api,
  type PaymentReconciliation,
  type PaymentRun
} from "../client-api";
import type { ProcessorScenario } from "../payments/protocol";
import {
  canCollectPayment,
  paymentLabel,
  paymentNeedsAttention,
  paymentPollDelay,
  pollPaymentRead
} from "./payment-state";

export function useCustomerPayments(
  customerId: string,
  version: number,
  onChanged: () => void
) {
  const [snapshot, setSnapshot] = useState<{
    customerId: string;
    payments: PaymentCollection[];
    inbox: PaymentInboxEvent[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previous = useRef("");
  useEffect(() => {
    setError(null);
    return pollPaymentRead(
      async () => ({
        customerId,
        payments: await api.payments(customerId),
        inbox: await api.paymentInbox(customerId)
      }),
      (next) => {
        const signature = JSON.stringify(next);
        const changed =
          previous.current !== "" && previous.current !== signature;
        previous.current = signature;
        setSnapshot(next);
        setError(null);
        if (changed) onChanged();
      },
      (e) => setError(e.message),
      (next) => paymentPollDelay(next.payments, next.inbox)
    );
  }, [customerId, version, onChanged]);
  return {
    snapshot: snapshot?.customerId === customerId ? snapshot : null,
    error
  };
}

export function PaymentAttention({
  payments,
  inbox
}: {
  payments: PaymentCollection[];
  inbox: PaymentInboxEvent[];
}) {
  const attention = payments.filter(paymentNeedsAttention);
  return (
    <div className="rounded-lg border border-kumo-line p-3 space-y-2 text-xs">
      <div className="flex justify-between gap-2 font-semibold text-kumo-default">
        <span>Needs attention</span>
        <span>
          {attention.length} invoices · {inbox.length} unapplied events
        </span>
      </div>
      {!attention.length && !inbox.length && (
        <p className="text-kumo-subtle">
          No unresolved reservations or unapplied webhooks.
        </p>
      )}
      {attention.map((p) => (
        <a
          key={p.invoiceId}
          href={`#payment-${p.invoiceId}`}
          className="block underline text-kumo-default break-all"
        >
          {p.invoiceId}: {paymentLabel(p.status)}
          {p.reservedCents > 0
            ? ` · ${formatCents(p.reservedCents)} reserved`
            : ""}
          {p.hasConflict ? " · conflicting results" : ""}
        </a>
      ))}
      {inbox.map((event) => (
        <div
          key={event.eventId}
          className="border-l-2 border-kumo-line pl-2 break-all text-kumo-subtle"
        >
          <a
            className="underline text-kumo-default"
            href={`#payment-${event.outcome.invoiceId}`}
          >
            {event.outcome.invoiceId}
          </a>
          <p>
            Webhook received, not applied: <code>{event.eventId}</code>
          </p>
          <p>
            Attempt <code>{event.outcome.attemptId}</code> ·{" "}
            {event.outcome.status}
          </p>
        </div>
      ))}
      {(attention.length > 0 || inbox.length > 0) && (
        <p className="text-kumo-subtle">
          Open the invoice's payment details to reconcile. Unresolved money
          stays reserved; retry cannot force a new charge.
        </p>
      )}
    </div>
  );
}

export function PaymentBadge({ payment }: { payment: PaymentCollection }) {
  const tone =
    payment.hasConflict ||
    payment.status === "needs_review" ||
    payment.status === "past_due"
      ? "text-kumo-danger"
      : payment.status === "paid" || payment.status === "settled"
        ? "text-kumo-success"
        : "text-kumo-default";
  return (
    <span className={tone}>
      <Badge variant="secondary">{paymentLabel(payment.status)}</Badge>
    </span>
  );
}

const scenarios: { label: string; values: ProcessorScenario[] }[] = [
  { label: "Success", values: ["success"] },
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
  },
  { label: "Clear queue (default success)", values: [] }
];

export function ReconciliationResult({
  result
}: {
  result: PaymentReconciliation;
}) {
  return (
    <div className="space-y-1 text-xs text-kumo-subtle" aria-live="polite">
      <p className="font-semibold text-kumo-default">Reconciliation results</p>
      <p>
        {result.inbox.length} inbox events checked · {result.checks.length}{" "}
        processor checks · {result.issues.length} internal ledger issues
      </p>
      {result.inbox.map((event) => (
        <p
          key={event.eventId}
          className={event.applied ? "" : "text-kumo-danger"}
        >
          Event <code className="break-all">{event.eventId}</code>:{" "}
          {event.applied
            ? "processing applied"
            : "unapplied — retry reconciliation"}
        </p>
      ))}
      {result.checks.map((check) => (
        <p
          key={check.attemptId}
          className={
            ["unresolved", "error", "conflict"].includes(check.result)
              ? "text-kumo-danger"
              : ""
          }
        >
          Attempt <code className="break-all">{check.attemptId}</code>:{" "}
          {check.result}
        </p>
      ))}
      {result.issues.map((issue, index) => (
        <pre
          key={index}
          className="whitespace-pre-wrap break-all text-kumo-danger"
        >
          {JSON.stringify(issue)}
        </pre>
      ))}
      {result.runs.map((run) => (
        <p key={run.collection.invoiceId}>
          Workflow {run.started ? "started" : "reused / not started"}:{" "}
          <code className="break-all">{run.id ?? "none"}</code>
        </p>
      ))}
      <p>
        Internal checks alone do not prove processor agreement. See the current
        financial status above.
      </p>
    </div>
  );
}

export function PaymentInvoice({
  payment,
  onChanged,
  stale = false
}: {
  payment: PaymentCollection;
  onChanged: () => void;
  stale?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [detail, setDetail] = useState<PaymentDetail | null>(null);
  const [run, setRun] = useState<PaymentRun | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<PaymentReconciliation | null>(null);
  const [scenario, setScenario] = useState(0);
  const [resume, setResume] = useState(false);
  const [reload, setReload] = useState(0);
  const alive = useRef(true);
  const acting = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!expanded) return;
    return pollPaymentRead(
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
    );
  }, [
    expanded,
    payment.invoiceId,
    payment.updatedAt,
    payment.methodVersion,
    payment.paidCents,
    payment.creditedCents,
    reload
  ]);

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
  const disabled = Boolean(busy || stale || readError);
  return (
    <div
      id={`payment-${payment.invoiceId}`}
      className="border-t border-kumo-line px-3 py-3 space-y-2 scroll-mt-3"
    >
      <div className="flex justify-between items-center gap-2">
        <PaymentBadge payment={payment} />
        <span className="text-xs text-kumo-subtle tabular-nums">
          {payment.attemptsUsed}/4 attempts · {payment.attemptsRemaining} left
        </span>
      </div>
      <dl className="grid grid-cols-3 gap-2 text-xs">
        {(
          [
            ["Paid", payment.paidCents],
            ["Reserved", payment.reservedCents],
            ["Due", payment.balanceCents]
          ] as const
        ).map(([label, cents]) => (
          <div key={label}>
            <dt className="text-kumo-subtle">{label}</dt>
            <dd className="text-kumo-default font-semibold tabular-nums">
              {formatCents(cents)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-kumo-subtle">
        Due includes unresolved reservations. Available for credit:{" "}
        {formatCents(payment.creditableCents)}.
      </p>
      <button
        type="button"
        className="text-xs underline text-kumo-default"
        aria-expanded={expanded}
        aria-controls={`payment-details-${payment.invoiceId}`}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "Hide" : "Payment details & controls"}
        {expanded ? " payment details" : ""}
      </button>
      {expanded && (
        <div
          id={`payment-details-${payment.invoiceId}`}
          className="space-y-3 pt-1"
        >
          <p className="text-xs text-kumo-subtle">
            Mock processor · no real money or email. Four new attempts maximum
            across retries, card updates and restarts; same-key recovery does
            not consume another attempt.
          </p>
          <div className="text-xs text-kumo-subtle space-y-1">
            <p>
              Workflow:{" "}
              <strong className="text-kumo-default">
                {run ? paymentLabel(run.status) : "loading…"}
              </strong>{" "}
              · Financial:{" "}
              <strong className="text-kumo-default">
                {paymentLabel(payment.status)}
              </strong>
            </p>
            <p>
              A completed Workflow is not proof of payment. Late reconciliation
              can still change financial state.
            </p>
            {run?.error && (
              <p className="text-kumo-danger">{run.error.message}</p>
            )}
            <details>
              <summary className="cursor-pointer text-kumo-default">
                Correlation IDs
              </summary>
              <dl className="break-all space-y-1 mt-1">
                <dt>Invoice</dt>
                <dd>
                  <code>{payment.invoiceId}</code>
                </dd>
                <dt>Workflow · generation {payment.generation}</dt>
                <dd>
                  <code>{payment.workflowId ?? "not started"}</code>
                </dd>
                <dt>Collection owner</dt>
                <dd>
                  <code>{payment.ownerId ?? "none"}</code> (
                  {payment.ownerActive ? "active" : "released"})
                </dd>
              </dl>
            </details>
          </div>
          {(readError || stale) && (
            <p role="alert" className="text-xs text-kumo-danger">
              Payment data may be stale.{" "}
              {readError ?? "Refresh failed; waiting for a successful read."}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={disabled || !canCollectPayment(payment)}
              onClick={() =>
                void act("Collecting", async () => {
                  const r = await api.collectPayment(payment.invoiceId);
                  return r.started
                    ? "Collection Workflow started; watch financial status."
                    : "Existing collection recovered or already settled; no forced new charge.";
                })
              }
            >
              Collect payment
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={disabled}
              onClick={() =>
                void act("Reconciling", async () => {
                  const r = await api.reconcilePayments(
                    payment.invoiceId,
                    resume
                  );
                  if (alive.current) setResult(r);
                  return "Reconciliation finished. Unresolved or conflicting checks still need attention.";
                })
              }
            >
              Reconcile payments
            </Button>
          </div>
          {!canCollectPayment(payment) && (
            <p className="text-xs text-kumo-subtle">
              Collection is blocked while owned, reserved, in review, awaiting a
              card, settled or out of attempts. Reconciliation can recover the
              original attempt; it cannot bypass these guards.
            </p>
          )}
          <label className="flex gap-2 items-start text-xs text-kumo-subtle">
            <input
              type="checkbox"
              checked={resume}
              onChange={(e) => setResume(e.target.checked)}
              disabled={Boolean(busy)}
            />
            <span>
              Also resume bounded collection after reconciliation (may charge
              remaining balance).
            </span>
          </label>
          <div className="border-t border-kumo-line pt-2 space-y-2">
            <p className="text-xs text-kumo-default font-semibold">
              Simulated payment method · version {payment.methodVersion}
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
                  return `Simulated card updated to version ${r.methodVersion} for this customer. If the Workflow ended, reconcile with resume enabled. Attempts were not reset.`;
                })
              }
            >
              Simulate card update
            </Button>
            <p className="text-xs text-kumo-subtle">
              No card data is collected. Hard declines wait up to 30 seconds for
              a newer method; duplicate updates cannot reset the attempt budget.
            </p>
          </div>
          <details className="text-xs text-kumo-subtle">
            <summary className="cursor-pointer font-semibold text-kumo-default">
              Mock scenario controls · future new attempts only
            </summary>
            <div className="space-y-2 pt-2">
              <select
                aria-label={`Mock scenario for ${payment.invoiceId}`}
                className="w-full px-2 py-1.5 rounded-lg border border-kumo-line bg-kumo-base text-kumo-default"
                value={scenario}
                disabled={Boolean(busy)}
                onChange={(e) => setScenario(Number(e.target.value))}
              >
                {scenarios.map((s, i) => (
                  <option key={s.label} value={i}>
                    {s.label}
                  </option>
                ))}
              </select>
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled || !canCollectPayment(payment)}
                onClick={() =>
                  void act("Saving scenario", async () => {
                    const r = await api.paymentScenarios(
                      payment.invoiceId,
                      scenarios[scenario].values
                    );
                    return `Mock queue saved: ${r.scenarios.join(" → ") || "default success"}. Now collect payment. Existing keys and paid invoices are unchanged.`;
                  })
                }
              >
                Save scenario queue
              </Button>
              <p>
                Use an existing finalized, uncollected invoice. New invoice runs
                collect automatically with default success. Saving replaces the
                future queue, never resets financial records. Pending checks
                wait 30 seconds; dunning delays are 3 / 6 / 9 seconds.
                Unresolved pending stays reserved for review.
              </p>
            </div>
          </details>
          {busy && (
            <output className="block text-xs text-kumo-subtle">{busy}…</output>
          )}
          {message && (
            <output className="block text-xs text-kumo-subtle">
              {message}
            </output>
          )}
          {actionError && (
            <p role="alert" className="text-xs text-kumo-danger">
              {actionError} No force retry was performed. Refresh or reconcile
              before retrying an uncertain request.
            </p>
          )}
          {result && <ReconciliationResult result={result} />}
          <div className="border-t border-kumo-line pt-2 space-y-2">
            <Text size="xs" bold>
              Durable payment timeline
            </Text>
            {!detail && !readError && (
              <p className="text-xs text-kumo-subtle">
                Loading attempts and timeline…
              </p>
            )}
            {detail?.attempts.map((attempt) => (
              <details key={attempt.id} className="text-xs text-kumo-subtle">
                <summary className="cursor-pointer text-kumo-default">
                  Attempt {attempt.attemptNumber} ·{" "}
                  {paymentLabel(attempt.state)}
                  {attempt.declineType
                    ? ` (${attempt.declineType} decline)`
                    : ""}{" "}
                  · {formatCents(attempt.amountCents)}
                </summary>
                <dl className="space-y-1 break-all pl-2 pt-1">
                  <dt>Attempt ID</dt>
                  <dd>
                    <code>{attempt.id}</code>
                  </dd>
                  <dt>Idempotency key</dt>
                  <dd>
                    <code>{attempt.idempotencyKey}</code>
                  </dd>
                  <dt>Processor payment ID</dt>
                  <dd>
                    <code>{attempt.processorPaymentId ?? "not confirmed"}</code>
                  </dd>
                  <dt>Original generation / method version</dt>
                  <dd>
                    {attempt.generation} / {attempt.methodVersion}
                  </dd>
                  <dt>Last updated</dt>
                  <dd>{attempt.updatedAt}</dd>
                  {Boolean(attempt.conflicted) && (
                    <dd className="text-kumo-danger">
                      Conflicting processor outcomes: manual review required.
                    </dd>
                  )}
                </dl>
              </details>
            ))}
            {detail && !detail.timeline.length && (
              <p className="text-xs text-kumo-subtle">No payment events yet.</p>
            )}
            <ol className="space-y-3 border-l border-kumo-line pl-3">
              {detail?.timeline.map((event) => (
                <li key={event.id} className="text-xs space-y-1">
                  <p className="font-medium text-kumo-default">
                    {paymentLabel(event.kind)}
                    {event.attemptNumber !== null
                      ? ` · attempt ${event.attemptNumber}`
                      : ""}
                  </p>
                  <p className="text-kumo-subtle">{event.message}</p>
                  <time className="text-kumo-subtle" dateTime={event.createdAt}>
                    {event.createdAt}
                  </time>
                  {event.deadlineAt && (
                    <p className="text-kumo-subtle">
                      Deadline: {event.deadlineAt}
                    </p>
                  )}
                  <details className="text-kumo-subtle">
                    <summary className="cursor-pointer">Event details</summary>
                    <p className="break-all">
                      <code>{event.id}</code> · generation {event.generation}
                    </p>
                  </details>
                </li>
              ))}
            </ol>
            <p className="text-xs text-kumo-subtle">
              Polling every 2s while active or reserved, 10s otherwise,
              including after Workflow completion.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
