import type { WorkflowStep } from "cloudflare:workers";
import {
  finalizeCollection,
  getPaymentCollection,
  markPaymentUncertain,
  preparePaymentAttempt,
  recordCollectionNotice,
  releaseCollection,
  type CollectionOwner,
  type PaymentAttempt
} from "../billing/payments.ts";
import {
  chargePayload,
  lookupAttempt,
  methodEventType,
  parseOutcome,
  paymentEventType,
  paymentLog,
  processorRequest,
  reconcileOutcome,
  type PaymentEnv
} from "./service.ts";

export const PAYMENT_TIMING = {
  pendingMs: 30_000,
  cardMs: 30_000,
  retryMs: [3_000, 6_000, 9_000]
} as const;

/**
 * Demo waits, optionally shortened by the PAYMENT_TIME_SCALE var. Only the
 * isolated payment-test Vite mode sets it; everywhere else the scale is 1.
 */
export function paymentTiming(env: PaymentEnv) {
  const scale = Number(env.PAYMENT_TIME_SCALE ?? 1);
  const k = Number.isFinite(scale) && scale > 0 && scale <= 1 ? scale : 1;
  return {
    pendingMs: PAYMENT_TIMING.pendingMs * k,
    cardMs: PAYMENT_TIMING.cardMs * k,
    retryMs: PAYMENT_TIMING.retryMs.map((ms) => ms * k)
  };
}
export const PAYMENT_RETRIES = {
  retries: { limit: 2, delay: "1 second", backoff: "exponential" },
  timeout: "10 seconds"
} as const;
const terminal = (a: PaymentAttempt) =>
  a.state === "succeeded" || a.state === "declined";

/** Checkpointed orchestration only. All financial decisions are delegated to merchant D1. */
export async function runPaymentCollection(
  env: PaymentEnv,
  owner: CollectionOwner,
  step: WorkflowStep
) {
  const timing = paymentTiming(env);
  const sleepUntilFuture = async (name: string, deadline: Date) => {
    if (Number(deadline) <= Date.now()) return;
    try {
      await step.sleepUntil(name, deadline);
    } catch (error) {
      // Local workerd rejects an elapsed sleep. The clock can cross the fixed
      // deadline after our guard; only that exact rejection is safe to skip.
      if (
        !(error instanceof Error) ||
        error.message !==
          "You can't sleep until a time in the past, time-traveler" ||
        Number(deadline) > Date.now()
      )
        throw error;
    }
  };
  const read = (name: string) =>
    step.do(name, PAYMENT_RETRIES, () =>
      getPaymentCollection(env.DB, owner.invoiceId)
    );
  const finish = (name: string) =>
    step.do(name, PAYMENT_RETRIES, () => finalizeCollection(env.DB, owner));
  const uncertain = (
    name: string,
    attempt: PaymentAttempt,
    state: "recovering" | "needs_review"
  ) =>
    step.do(name, PAYMENT_RETRIES, () =>
      markPaymentUncertain(env.DB, owner, attempt.id, state)
    );

  // Four attempts plus finalization, with a separate bounded allowance for changed
  // preparation snapshots. Exhaustion fails visibly with ownership retained for recovery;
  // it must never silently end an unfinished collection or invent a past-due decision.
  const maxReevaluations = 8;
  let reevaluations = 0;
  let finished = false;
  for (let turn = 0; turn < 5 + maxReevaluations; turn++) {
    const prefix = `turn-${turn}`;
    const current = await read(`${prefix}-state`);
    if (
      current.hasConflict ||
      current.balanceCents === 0 ||
      (current.attemptsRemaining === 0 && !current.reservedCents)
    ) {
      await finish(`${prefix}-finalize`);
      finished = true;
      break;
    }
    const previous = current.attempts.at(-1);
    if (previous?.state === "declined") {
      if (
        previous.declineType === "hard" &&
        current.methodVersion <= previous.methodVersion
      ) {
        const notice = await step.do(
          `${prefix}-card-notice`,
          PAYMENT_RETRIES,
          () =>
            recordCollectionNotice(env.DB, owner, {
              id: `${previous.id}:card`,
              attemptNumber: previous.attemptNumber,
              kind: "card_update_requested",
              message:
                "Update the simulated payment method to continue collection.",
              deadlineAt: new Date(Date.now() + timing.cardMs).toISOString()
            })
        );
        const deadline = Date.parse(notice.deadlineAt!);
        let after = await read(`${prefix}-before-card-wait`);
        if (
          after.methodVersion <= previous.methodVersion &&
          after.balanceCents > 0 &&
          Date.now() < deadline
        ) {
          try {
            await step.waitForEvent(`${prefix}-card-event`, {
              type: methodEventType,
              timeout: Math.max(1, deadline - Date.now())
            });
          } catch {
            /* Timeout is a bounded business outcome, not a failed Workflow. */
          }
          after = await read(`${prefix}-after-card-event`);
          // Stale/duplicate hints neither grant permission nor extend the original deadline.
          for (
            let poll = 0;
            poll < 6 &&
            after.methodVersion <= previous.methodVersion &&
            after.balanceCents > 0 &&
            Date.now() < deadline;
            poll++
          ) {
            await step.sleep(
              `${prefix}-card-poll-${poll}`,
              Math.min(5000, Math.max(1, deadline - Date.now()))
            );
            after = await read(`${prefix}-card-poll-state-${poll}`);
          }
        }
        // Replay may skip every clock-dependent wait/read above. It must still execute
        // this stable decision checkpoint, including after an interruption before it.
        after = await read(`${prefix}-card-decision`);
        if (
          after.balanceCents === 0 ||
          after.methodVersion <= previous.methodVersion
        ) {
          await finish(`${prefix}-card-finalize`);
          finished = true;
          break;
        }
      } else if (previous.declineType === "soft") {
        const notice = await step.do(
          `${prefix}-retry-notice`,
          PAYMENT_RETRIES,
          () =>
            recordCollectionNotice(env.DB, owner, {
              id: `${previous.id}:retry`,
              attemptNumber: previous.attemptNumber,
              kind: "retry_scheduled",
              message: `Dunning retry slot ${previous.attemptNumber} (day ${[1, 3, 7][previous.attemptNumber - 1]} in production).`,
              // Each newly declined attempt schedules a distinct slot relative to now, never a catch-up burst.
              deadlineAt: new Date(
                Date.now() + timing.retryMs[previous.attemptNumber - 1]
              ).toISOString()
            })
        );
        await sleepUntilFuture(
          `${prefix}-dunning-delay`,
          new Date(notice.deadlineAt!)
        );
      }
    }
    const prepared = await step.do(`${prefix}-prepare`, PAYMENT_RETRIES, () =>
      preparePaymentAttempt(
        env.DB,
        owner,
        new Date(Date.now()),
        previous ?? null
      )
    );
    if (prepared.kind === "reevaluate") {
      paymentLog(
        "payment_preparation_reevaluate",
        {
          invoiceId: owner.invoiceId,
          workflowInstanceId: owner.workflowId,
          attemptId: prepared.collection.attempts.at(-1)?.id
        },
        { reevaluation: ++reevaluations }
      );
      if (reevaluations > maxReevaluations)
        throw new Error(
          "Payment preparation kept changing; reconcile and resume collection"
        );
      continue;
    }
    if (prepared.kind !== "attempt") {
      await finish(`${prefix}-guarded-finalize`);
      finished = true;
      break;
    }
    const attempt = prepared.attempt;
    const identity = {
      invoiceId: owner.invoiceId,
      workflowInstanceId: owner.workflowId,
      attemptId: attempt.id,
      processorPaymentId: attempt.processorPaymentId
    };
    // Only the mock's explicit indefinite-retention contract permits charge replay.
    // Uncertain attempts use status only; no expiry or missing retention proof permits a POST.
    if (attempt.state === "prepared") {
      try {
        await step.do(
          `${prefix}-charge-${attempt.attemptNumber}`,
          PAYMENT_RETRIES,
          async () => {
            const durable = await getPaymentCollection(env.DB, owner.invoiceId);
            const latest = durable.attempts.find((a) => a.id === attempt.id)!;
            if (terminal(latest) || durable.hasConflict) return;
            const retention = await processorRequest(
              env,
              `/demo/inspect?invoiceId=${encodeURIComponent(attempt.invoiceId)}`
            );
            if (
              !retention.ok ||
              ((await retention.json()) as { keyRetention?: string })
                .keyRetention !== "indefinite"
            )
              throw new Error(
                "processor key retention not guaranteed; status reconciliation required"
              );
            paymentLog("processor_charge", identity, {
              attemptNumber: attempt.attemptNumber
            });
            // Transport notices make same-key recovery visible in the timeline.
            // They are best-effort: a failed notice never changes the charge flow.
            const notice = (
              kind: "charge_unanswered" | "charge_replayed",
              id: string,
              message: string
            ) =>
              recordCollectionNotice(env.DB, owner, {
                id: `${attempt.id}:g${owner.generation}:${id}`,
                attemptNumber: attempt.attemptNumber,
                kind,
                message
              }).catch(() => undefined);
            let response: Response;
            try {
              response = await processorRequest(
                env,
                "/charges",
                "POST",
                chargePayload(attempt)
              );
            } catch (error) {
              await notice(
                "charge_unanswered",
                `unanswered:${Date.now()}`,
                "Charge got no response (timeout). Retrying with the same key."
              );
              throw error;
            }
            if (!response.ok) {
              await notice(
                "charge_unanswered",
                `unanswered:${Date.now()}`,
                `Charge got no usable response (HTTP ${response.status}). Retrying with the same key.`
              );
              throw new Error(`processor HTTP ${response.status}`);
            }
            const body = (await response.json()) as {
              charge: unknown;
              replayed?: boolean;
            };
            const outcome = parseOutcome(body.charge);
            if (body.replayed)
              await notice(
                "charge_replayed",
                "replayed",
                "Processor replayed the original charge for this key. No second charge."
              );
            if (
              Object.entries(chargePayload(attempt)).some(
                ([k, v]) => outcome[k as keyof typeof outcome] !== v
              )
            )
              throw new Error("processor response identity mismatch");
            await reconcileOutcome(env, outcome);
          }
        );
      } catch {
        // Exhausted step.do retries MUST lead to original-key lookup, not a failed run/new key.
        paymentLog("processor_charge_retries_exhausted", identity);
        await uncertain(`${prefix}-recovering`, attempt, "recovering");
      }
    }
    let state = await read(`${prefix}-after-charge`);
    let latest = state.attempts.find((a) => a.id === attempt.id)!;
    for (
      let check = 0;
      check < 3 && !terminal(latest) && !state.hasConflict;
      check++
    ) {
      const recovery = `${prefix}-recovery-${check}`;
      // A fixed durable deadline survives replay; hints cannot reset it or spend extra checks.
      const notice = await step.do(`${recovery}-notice`, PAYMENT_RETRIES, () =>
        recordCollectionNotice(env.DB, owner, {
          id: `${owner.workflowId}:${attempt.id}:check:${check}`,
          attemptNumber: attempt.attemptNumber,
          kind: "recovery_check",
          message: `Original-key recovery check ${check + 1} of 3.`,
          deadlineAt: new Date(Date.now() + timing.pendingMs).toISOString()
        })
      );
      state = await read(`${recovery}-before-wait`);
      latest = state.attempts.find((a) => a.id === attempt.id)!;
      const deadline = Date.parse(notice.deadlineAt!);
      // Exhausted charge retries go straight to the first lookup; pending charges wait first.
      if (
        !terminal(latest) &&
        !state.hasConflict &&
        (check > 0 || latest.state === "pending") &&
        Date.now() < deadline
      ) {
        try {
          await step.waitForEvent(`${recovery}-event`, {
            type: paymentEventType(attempt.attemptNumber),
            timeout: Math.max(1, deadline - Date.now())
          });
        } catch {
          /* Timeout falls through to D1 and status lookup. */
        }
        state = await read(`${recovery}-after-wait`);
        latest = state.attempts.find((a) => a.id === attempt.id)!;
        if (!terminal(latest) && !state.hasConflict) {
          await sleepUntilFuture(`${recovery}-deadline`, new Date(deadline));
          state = await read(`${recovery}-after-deadline`);
          latest = state.attempts.find((a) => a.id === attempt.id)!;
        }
      }
      if (!terminal(latest) && !state.hasConflict) {
        try {
          await step.do(`${recovery}-lookup`, PAYMENT_RETRIES, async () => {
            await lookupAttempt(env, attempt, owner.workflowId);
          });
        } catch {
          paymentLog("processor_lookup_retries_exhausted", identity, {
            check: check + 1
          });
        }
        state = await read(`${recovery}-after-lookup`);
        latest = state.attempts.find((a) => a.id === attempt.id)!;
      }
    }
    if (!terminal(latest) || state.hasConflict) {
      await uncertain(`${prefix}-needs-review`, attempt, "needs_review");
      finished = true;
      break;
    }
    if (latest.state === "succeeded") {
      finished = true;
      break;
    }
  }
  if (!finished)
    throw new Error(
      "Payment collection did not finish within its decision budget; reconcile and resume collection"
    );
  await step.do("release-collection-owner", PAYMENT_RETRIES, () =>
    releaseCollection(env.DB, owner)
  );
  const result = await read("final-payment-state");
  paymentLog(
    "payment_collection_finished",
    { invoiceId: owner.invoiceId, workflowInstanceId: owner.workflowId },
    { status: result.status, attemptsUsed: result.attemptsUsed }
  );
  return {
    invoiceId: owner.invoiceId,
    status: result.status,
    attemptsUsed: result.attemptsUsed
  };
}
