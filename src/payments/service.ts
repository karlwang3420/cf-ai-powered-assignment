import {
  applyPaymentOutcome,
  applyPaymentWebhook,
  claimCollection,
  debugResetPayment,
  getPaymentCollection,
  grantManualRetry,
  listPaymentCollections,
  listPaymentInbox,
  markPaymentWebhookNotified,
  receivePaymentWebhook,
  reconcilePayments,
  releaseCollection,
  type CollectionOwner,
  type PaymentAttempt,
  type PaymentOutcome
} from "../billing/payments.ts";
import { BillingError } from "../billing/store.ts";
import {
  verifyProcessorWebhook,
  type ChargeRequest,
  type ProcessorWebhook
} from "./protocol.ts";

export type PaymentEnv = {
  DB: D1Database;
  PAYMENT_WORKFLOW: Pick<Workflow<CollectionOwner>, "create" | "get">;
  PAYMENT_PROCESSOR: Pick<Fetcher, "fetch">;
  PROCESSOR_TOKEN: string;
  PROCESSOR_WEBHOOK_SECRET: string;
  /** Test-only multiplier (0–1] for demo waits; unset means real demo timing. */
  PAYMENT_TIME_SCALE?: string;
};

export function paymentLog(
  event: string,
  identity: {
    invoiceId?: string;
    workflowInstanceId?: string | null;
    attemptId?: string;
    processorPaymentId?: string | null;
  },
  detail: Record<string, string | number | boolean> = {}
) {
  console.log(JSON.stringify({ event, ...identity, ...detail }));
}

export const paymentEventType = (attemptNumber: number) =>
  `payment-attempt-${attemptNumber}`;
export const methodEventType = "payment-method-updated";

export function chargePayload(attempt: PaymentAttempt): ChargeRequest {
  return {
    invoiceId: attempt.invoiceId,
    attemptId: attempt.id,
    idempotencyKey: attempt.idempotencyKey,
    amountCents: attempt.amountCents,
    currency: attempt.currency,
    methodVersion: attempt.methodVersion
  };
}

export async function processorRequest(
  env: PaymentEnv,
  path: string,
  method = "GET",
  body?: unknown
) {
  return env.PAYMENT_PROCESSOR.fetch(
    new Request(`https://processor.internal${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.PROCESSOR_TOKEN}`,
        "content-type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
      redirect: "manual"
    })
  );
}

export function parseOutcome(value: unknown): PaymentOutcome {
  if (!value || typeof value !== "object")
    throw new BillingError("invalid", "invalid processor outcome");
  const v = value as Record<string, unknown>;
  for (const field of [
    "invoiceId",
    "attemptId",
    "idempotencyKey",
    "processorPaymentId"
  ]) {
    if (
      typeof v[field] !== "string" ||
      !(v[field] as string).trim() ||
      (v[field] as string).length > 500
    )
      throw new BillingError("invalid", `invalid ${field}`);
  }
  if (
    !Number.isSafeInteger(v.amountCents) ||
    Number(v.amountCents) <= 0 ||
    !Number.isSafeInteger(v.methodVersion) ||
    Number(v.methodVersion) <= 0 ||
    v.currency !== "USD" ||
    !["pending", "succeeded", "declined"].includes(String(v.status)) ||
    (v.status === "declined" &&
      !["soft", "hard"].includes(String(v.declineType)))
  )
    throw new BillingError("invalid", "invalid processor outcome");
  return v as PaymentOutcome;
}

/** Shared financial application; notification is never inside the financial transaction. */
export async function reconcileOutcome(
  env: PaymentEnv,
  outcome: PaymentOutcome,
  eventId?: string
) {
  const result =
    eventId === undefined
      ? await applyPaymentOutcome(env.DB, outcome)
      : await applyPaymentWebhook(env.DB, eventId);
  paymentLog(
    "payment_reconciled",
    {
      invoiceId: outcome.invoiceId,
      workflowInstanceId: result.collection.workflowId,
      attemptId: outcome.attemptId,
      processorPaymentId: outcome.processorPaymentId
    },
    { result: result.status, status: outcome.status }
  );
  return result;
}

export async function lookupAttempt(
  env: PaymentEnv,
  attempt: PaymentAttempt,
  workflowInstanceId?: string | null
) {
  try {
    const response = await processorRequest(
      env,
      `/charges?idempotencyKey=${encodeURIComponent(attempt.idempotencyKey)}`
    );
    if (!response.ok) {
      paymentLog(
        "processor_lookup_unresolved",
        {
          invoiceId: attempt.invoiceId,
          workflowInstanceId,
          attemptId: attempt.id,
          processorPaymentId: attempt.processorPaymentId
        },
        { httpStatus: response.status }
      );
      return null;
    }
    const body = (await response.json()) as { charge: unknown };
    const outcome = parseOutcome(body.charge);
    // Do not let an incorrect lookup response apply to a different valid attempt.
    assertAttemptIdentity(attempt, outcome);
    return await reconcileOutcome(env, outcome);
  } catch (error) {
    if (error instanceof BillingError) throw error;
    paymentLog("processor_lookup_unavailable", {
      invoiceId: attempt.invoiceId,
      workflowInstanceId,
      attemptId: attempt.id,
      processorPaymentId: attempt.processorPaymentId
    });
    return null;
  }
}

function assertAttemptIdentity(
  attempt: PaymentAttempt | undefined,
  outcome: PaymentOutcome
) {
  if (
    !attempt ||
    Object.entries(chargePayload(attempt)).some(
      ([key, value]) => outcome[key as keyof PaymentOutcome] !== value
    ) ||
    (attempt.processorPaymentId !== null &&
      attempt.processorPaymentId !== outcome.processorPaymentId)
  )
    throw new BillingError(
      "conflict",
      "processor identity does not match persisted attempt"
    );
}

export async function notifyPayment(
  env: PaymentEnv,
  outcome: PaymentOutcome,
  eventId?: string
) {
  // Pending receipt is durable but cannot resolve a wait; only terminal proof is a useful hint.
  if (outcome.status === "pending") return false;
  const collection = await getPaymentCollection(env.DB, outcome.invoiceId);
  const attempt = collection.attempts.find((a) => a.id === outcome.attemptId);
  if (!collection.ownerActive || !collection.workflowId || !attempt)
    return false;
  try {
    const instance = await env.PAYMENT_WORKFLOW.get(collection.workflowId);
    await instance.sendEvent({
      type: paymentEventType(attempt.attemptNumber),
      payload: {
        invoiceId: outcome.invoiceId,
        attemptId: outcome.attemptId,
        processorPaymentId: outcome.processorPaymentId
      }
    });
    if (eventId) await markPaymentWebhookNotified(env.DB, eventId);
    return true;
  } catch {
    paymentLog("payment_notification_failed", {
      invoiceId: outcome.invoiceId,
      workflowInstanceId: collection.workflowId,
      attemptId: outcome.attemptId,
      processorPaymentId: outcome.processorPaymentId
    });
    return false;
  }
}

export async function receiveWebhook(request: Request, env: PaymentEnv) {
  const raw = await request.text();
  if (raw.length > 16384)
    return Response.json(
      { error: { code: "invalid", message: "body too large" } },
      { status: 413 }
    );
  if (
    !(await verifyProcessorWebhook(
      raw,
      request.headers,
      env.PROCESSOR_WEBHOOK_SECRET
    ))
  )
    return Response.json(
      { error: { code: "unauthorized", message: "invalid signature" } },
      { status: 401 }
    );
  let event: ProcessorWebhook;
  try {
    event = JSON.parse(raw);
  } catch {
    throw new BillingError("invalid", "invalid webhook JSON");
  }
  if (
    !event ||
    event.type !== "payment.updated" ||
    typeof event.eventId !== "string" ||
    !event.eventId.trim() ||
    event.eventId.length > 500 ||
    typeof event.createdAt !== "string" ||
    !Number.isFinite(Date.parse(event.createdAt))
  )
    throw new BillingError("invalid", "invalid webhook envelope");
  const outcome = parseOutcome(event.charge);
  const collection = await getPaymentCollection(env.DB, outcome.invoiceId);
  assertAttemptIdentity(
    collection.attempts.find((a) => a.id === outcome.attemptId),
    outcome
  );
  const receipt = await receivePaymentWebhook(env.DB, event.eventId, outcome);
  let applied = false;
  try {
    await reconcileOutcome(env, outcome, event.eventId);
    applied = true;
    await notifyPayment(env, outcome, event.eventId);
  } catch {
    // Durable receipt is acknowledged even if application fails; Reconcile payments owns retry.
    paymentLog("payment_inbox_retry_required", {
      invoiceId: outcome.invoiceId,
      workflowInstanceId: collection.workflowId,
      attemptId: outcome.attemptId,
      processorPaymentId: outcome.processorPaymentId
    });
  }
  return Response.json(
    { received: true, duplicate: receipt.status === "duplicate", applied },
    { status: 202 }
  );
}

function ownerOf(
  c: Awaited<ReturnType<typeof getPaymentCollection>>
): CollectionOwner {
  return {
    invoiceId: c.invoiceId,
    generation: c.generation,
    ownerId: c.ownerId!,
    workflowId: c.workflowId!
  };
}

/**
 * Local debug reset to unpaid. Processor state is cleared first so a failure
 * leaves D1 untouched and the reset can simply be retried.
 */
export async function debugResetCollection(env: PaymentEnv, invoiceId: string) {
  const c = await getPaymentCollection(env.DB, invoiceId);
  if (c.workflowId)
    try {
      await (await env.PAYMENT_WORKFLOW.get(c.workflowId)).terminate();
    } catch {
      // Already finished or unknown; the generation bump fences it anyway.
    }
  const response = await processorRequest(env, "/demo/reset", "POST", {
    invoiceId
  });
  if (!response.ok)
    throw new BillingError(
      "conflict",
      `processor reset failed (${response.status}); nothing was changed`
    );
  paymentLog("payment_debug_reset", {
    invoiceId,
    workflowInstanceId: c.workflowId
  });
  return debugResetPayment(env.DB, invoiceId);
}

/** Lost create responses and concurrent callers always reuse the D1 generation ID. */
export async function startCollection(env: PaymentEnv, invoiceId: string) {
  for (let race = 0; race < 3; race++) {
    const c = await getPaymentCollection(env.DB, invoiceId);
    if (!c.hasConflict && !c.reservedCents && c.balanceCents === 0)
      return { id: c.workflowId, started: false, collection: c };
    if (c.ownerActive && c.workflowId) {
      let status: string | undefined;
      try {
        status = (await (await env.PAYMENT_WORKFLOW.get(c.workflowId)).status())
          .status;
      } catch {
        /* A claim may exist before create; create below uses the same ID. */
      }
      if (status && ["complete", "errored", "terminated"].includes(status)) {
        try {
          await releaseCollection(env.DB, ownerOf(c));
        } catch (error) {
          if (!(error instanceof BillingError) || error.code !== "conflict")
            throw error;
        }
        continue;
      }
      if (status && status !== "unknown")
        return { id: c.workflowId, started: false, collection: c };
    }
    let owner: CollectionOwner;
    try {
      owner = await claimCollection(env.DB, invoiceId, c.generation);
    } catch (error) {
      if (error instanceof BillingError && error.code === "conflict") continue;
      throw error;
    }
    try {
      await env.PAYMENT_WORKFLOW.create({
        id: owner.workflowId,
        params: owner
      });
    } catch (error) {
      // get() may return a handle even for a missing ID; status() must succeed too.
      try {
        const status = await (
          await env.PAYMENT_WORKFLOW.get(owner.workflowId)
        ).status();
        if (status.status === "unknown") throw error;
      } catch {
        throw error;
      }
    }
    paymentLog(
      "payment_collection_started",
      { invoiceId, workflowInstanceId: owner.workflowId },
      { generation: owner.generation }
    );
    return {
      id: owner.workflowId,
      started: true,
      collection: await getPaymentCollection(env.DB, invoiceId)
    };
  }
  throw new BillingError("conflict", "collection changed; reload and retry");
}

/**
 * Admin retry. While automatic attempts remain this is plain collection;
 * once they are used it first allows exactly one manual attempt.
 */
export async function retryCollection(env: PaymentEnv, invoiceId: string) {
  const c = await getPaymentCollection(env.DB, invoiceId);
  if (c.attemptsRemaining === 0) {
    await grantManualRetry(env.DB, invoiceId);
    paymentLog(
      "payment_manual_retry",
      { invoiceId, workflowInstanceId: c.workflowId },
      { attemptNumber: c.attemptsUsed + 1 }
    );
  }
  return startCollection(env, invoiceId);
}

export async function reconcilePaymentCollections(
  env: PaymentEnv,
  invoiceId?: string,
  resume = false
) {
  if (invoiceId) await getPaymentCollection(env.DB, invoiceId);
  const inbox: { eventId: string; applied: boolean }[] = [];
  for (const event of await listPaymentInbox(env.DB)) {
    if (invoiceId && event.outcome.invoiceId !== invoiceId) continue;
    try {
      await reconcileOutcome(env, event.outcome, event.eventId);
      await notifyPayment(env, event.outcome, event.eventId);
      inbox.push({ eventId: event.eventId, applied: true });
    } catch {
      inbox.push({ eventId: event.eventId, applied: false });
    }
  }
  const checks: { invoiceId: string; attemptId: string; result: string }[] = [];
  const runs: Awaited<ReturnType<typeof startCollection>>[] = [];
  for (const c of await listPaymentCollections(env.DB)) {
    if (invoiceId && c.invoiceId !== invoiceId) continue;
    const detail = await getPaymentCollection(env.DB, c.invoiceId);
    for (const attempt of detail.attempts) {
      try {
        const result = await lookupAttempt(env, attempt, detail.workflowId);
        const observed = result?.collection.attempts.find(
          (a) => a.id === attempt.id
        );
        checks.push({
          invoiceId: c.invoiceId,
          attemptId: attempt.id,
          result:
            result?.status === "conflict"
              ? "conflict"
              : observed?.state === "succeeded" ||
                  observed?.state === "declined"
                ? result!.status
                : "unresolved"
        });
      } catch {
        checks.push({
          invoiceId: c.invoiceId,
          attemptId: attempt.id,
          result: "error"
        });
      }
    }
    if (resume) runs.push(await startCollection(env, c.invoiceId));
  }
  return { inbox, checks, runs, issues: await reconcilePayments(env.DB) };
}
