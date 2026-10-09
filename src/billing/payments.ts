/** Merchant D1 payment state. No processor transport or Workflow dependency.
 * Every financial guard is evaluated in SQL inside the mutation's transaction.
 */
import { BillingError, type ReconciliationIssue } from "./store.ts";

export type CollectionStatus =
  | "open"
  | "processing"
  | "recovering"
  | "retrying"
  | "action_required"
  | "needs_review"
  | "paid"
  | "settled"
  | "past_due";
export type AttemptState =
  | "prepared"
  | "pending"
  | "recovering"
  | "needs_review"
  | "succeeded"
  | "declined";
export type CollectionOwner = {
  invoiceId: string;
  generation: number;
  ownerId: string;
  workflowId: string;
};
export type PaymentAttempt = {
  id: string;
  invoiceId: string;
  attemptNumber: number;
  generation: number;
  amountCents: number;
  currency: "USD";
  methodVersion: number;
  idempotencyKey: string;
  state: AttemptState;
  declineType: "soft" | "hard" | null;
  processorPaymentId: string | null;
  conflicted: number;
  createdAt: string;
  updatedAt: string;
};
export type PaymentTimelineEntry = {
  id: string;
  invoiceId: string;
  generation: number;
  attemptNumber: number | null;
  kind: string;
  message: string;
  deadlineAt: string | null;
  createdAt: string;
};
export type PaymentCollection = {
  invoiceId: string;
  customerId: string;
  currency: "USD";
  status: CollectionStatus;
  totalCents: number;
  creditedCents: number;
  paidCents: number;
  reservedCents: number;
  balanceCents: number;
  creditableCents: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  generation: number;
  ownerId: string | null;
  workflowId: string | null;
  ownerActive: number;
  hasConflict: number;
  needsAttention: number;
  methodVersion: number;
  updatedAt: string;
};
export type PaymentDetail = PaymentCollection & {
  attempts: PaymentAttempt[];
  timeline: PaymentTimelineEntry[];
};

const COLLECTION_SELECT = `SELECT c.invoice_id AS invoiceId, b.customer_id AS customerId,
 c.currency, c.status, b.total_cents AS totalCents, b.credited_cents AS creditedCents,
 b.paid_cents AS paidCents, b.reserved_cents AS reservedCents,
 b.total_cents - b.credited_cents - b.paid_cents AS balanceCents,
 b.total_cents - b.credited_cents - b.paid_cents - b.reserved_cents AS creditableCents,
 c.attempts_used AS attemptsUsed, 4 - c.attempts_used AS attemptsRemaining,
 c.generation, c.owner_id AS ownerId, c.workflow_id AS workflowId, c.owner_active AS ownerActive,
 c.has_conflict AS hasConflict, (c.has_conflict = 1 OR b.reserved_cents > 0 OR c.status IN ('needs_review', 'action_required', 'past_due')) AS needsAttention,
 m.version AS methodVersion, c.updated_at AS updatedAt
 FROM payment_collections c JOIN payment_balances b ON b.invoice_id = c.invoice_id
 JOIN payment_methods m ON m.customer_id = b.customer_id`;
const ATTEMPT_SELECT = `SELECT id, invoice_id AS invoiceId, attempt_number AS attemptNumber, generation,
 amount_cents AS amountCents, currency, method_version AS methodVersion, idempotency_key AS idempotencyKey,
 state, decline_type AS declineType, processor_payment_id AS processorPaymentId, conflicted,
 created_at AS createdAt, updated_at AS updatedAt FROM payment_attempts`;
const TIMELINE_SELECT = `SELECT id, invoice_id AS invoiceId, generation, attempt_number AS attemptNumber,
 kind, message, deadline_at AS deadlineAt, created_at AS createdAt FROM payment_timeline`;
const ownerGuard = `invoice_id = ?1 AND generation = ?2 AND owner_id = ?3 AND owner_active = 1`;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new BillingError(
      "invalid",
      `${field} must be a non-empty string of at most 500 characters`
    );
  }
  return value;
}
function integer(value: unknown, field: string, minimum = 1): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  ) {
    throw new BillingError(
      "invalid",
      `${field} must be a safe integer >= ${minimum}`
    );
  }
  return value;
}
function ownerValues(owner: CollectionOwner): [string, number, string] {
  return [
    text(owner.invoiceId, "invoiceId"),
    integer(owner.generation, "generation"),
    text(owner.ownerId, "ownerId")
  ];
}
function assertOwner(collection: PaymentCollection, owner: CollectionOwner) {
  if (
    !collection.ownerActive ||
    collection.generation !== owner.generation ||
    collection.ownerId !== owner.ownerId
  ) {
    throw new BillingError("conflict", "stale collection owner");
  }
}

export async function getPaymentCollection(
  db: D1Database,
  invoiceId: string
): Promise<PaymentDetail> {
  const [collections, attempts, timeline] = await db.batch([
    db
      .prepare(`${COLLECTION_SELECT} WHERE c.invoice_id = ?`)
      .bind(text(invoiceId, "invoiceId")),
    db
      .prepare(`${ATTEMPT_SELECT} WHERE invoice_id = ? ORDER BY attempt_number`)
      .bind(invoiceId),
    db
      .prepare(
        `${TIMELINE_SELECT} WHERE invoice_id = ? ORDER BY created_at, rowid`
      )
      .bind(invoiceId)
  ]);
  const collection = (collections.results as PaymentCollection[])[0];
  if (!collection) {
    const invoice = await db
      .prepare("SELECT status FROM invoices WHERE id = ?")
      .bind(invoiceId)
      .first();
    throw new BillingError(
      invoice ? "conflict" : "not_found",
      invoice ? "invoice is not finalized" : `unknown invoice "${invoiceId}"`
    );
  }
  return {
    ...collection,
    attempts: attempts.results as PaymentAttempt[],
    timeline: timeline.results as PaymentTimelineEntry[]
  };
}

export async function listPaymentCollections(
  db: D1Database,
  customerId?: string
): Promise<PaymentCollection[]> {
  const statement = db.prepare(
    `${COLLECTION_SELECT}${customerId === undefined ? "" : " WHERE b.customer_id = ?"} ORDER BY c.invoice_id`
  );
  const { results } = await (
    customerId === undefined
      ? statement
      : statement.bind(text(customerId, "customerId"))
  ).all<PaymentCollection>();
  return results;
}

/** CAS version bump: duplicate card-update requests with the same expected version do not advance it again. */
export async function updatePaymentMethod(
  db: D1Database,
  customerId: string,
  expectedVersion: number
): Promise<number> {
  await db
    .prepare(
      "UPDATE payment_methods SET version = version + 1 WHERE customer_id = ? AND version = ?"
    )
    .bind(
      text(customerId, "customerId"),
      integer(expectedVersion, "expectedVersion")
    )
    .run();
  const row = await db
    .prepare("SELECT version FROM payment_methods WHERE customer_id = ?")
    .bind(customerId)
    .first<{ version: number }>();
  if (!row)
    throw new BillingError("not_found", `unknown customer "${customerId}"`);
  return row.version;
}

/** Claim an inactive generation with compare-and-swap; an active run is returned for create/recover.
 * Initial expectedGeneration is 0. Restart uses the last observed inactive generation.
 * Persisted workflowId is stable, including after a lost Workflow.create response.
 */
export async function claimCollection(
  db: D1Database,
  invoiceId: string,
  expectedGeneration: number,
  now = new Date()
): Promise<CollectionOwner> {
  text(invoiceId, "invoiceId");
  integer(expectedGeneration, "expectedGeneration", 0);
  const ownerId = crypto.randomUUID();
  await db.batch([
    db
      .prepare(`UPDATE payment_collections SET generation = generation + 1, owner_id = ?3,
      workflow_id = ?4, owner_active = 1, updated_at = ?5
      WHERE invoice_id = ?1 AND generation = ?2 AND owner_active = 0`)
      .bind(
        invoiceId,
        expectedGeneration,
        ownerId,
        `payment-${crypto.randomUUID()}`,
        now.toISOString()
      ),
    db
      .prepare(`INSERT INTO payment_timeline (id, invoice_id, generation, kind, message, created_at)
      SELECT 'owner:' || owner_id, invoice_id, generation, 'owner_claimed', workflow_id, ?2
      FROM payment_collections WHERE invoice_id = ?1 AND owner_id = ?3 ON CONFLICT (id) DO NOTHING`)
      .bind(invoiceId, now.toISOString(), ownerId)
  ]);
  const c = await getPaymentCollection(db, invoiceId);
  if (
    !c.ownerActive ||
    c.generation < expectedGeneration ||
    c.generation > expectedGeneration + 1
  ) {
    throw new BillingError(
      "conflict",
      "collection generation changed; reload before claiming"
    );
  }
  return {
    invoiceId,
    generation: c.generation,
    ownerId: c.ownerId!,
    workflowId: c.workflowId!
  };
}

/** Ends ownership only, never the campaign or reservation. Old owners cannot release a new generation. */
export async function releaseCollection(
  db: D1Database,
  owner: CollectionOwner,
  now = new Date()
): Promise<void> {
  const result = await db
    .prepare(
      `UPDATE payment_collections SET owner_active = 0, updated_at = ?4 WHERE ${ownerGuard}`
    )
    .bind(...ownerValues(owner), now.toISOString())
    .run();
  if (!result.meta.changes) {
    const c = await getPaymentCollection(db, owner.invoiceId);
    if (c.generation !== owner.generation || c.ownerId !== owner.ownerId)
      throw new BillingError("conflict", "stale collection owner");
  }
}

export type PreparationGate = Pick<
  PaymentAttempt,
  "id" | "state" | "declineType"
> | null;
export type PreparePaymentResult =
  | { kind: "attempt"; created: boolean; attempt: PaymentAttempt }
  | {
      kind: "settled" | "budget_exhausted" | "reevaluate" | "needs_review";
      collection: PaymentDetail;
    };

/** Only this operation allocates a new key. The caller supplies the previous attempt/state
 * whose dunning/card gate it evaluated. Default null permits only the initial attempt,
 * never an implicit manual retry. Soft retries also require an elapsed durable notice.
 * Mutations and the returned decision snapshot share one D1 batch/transaction.
 */
export async function preparePaymentAttempt(
  db: D1Database,
  owner: CollectionOwner,
  now = new Date(),
  expectedPreviousAttempt: PreparationGate = null
): Promise<PreparePaymentResult> {
  const [inserted, , collections, attempts, timeline] = await db.batch([
    db
      .prepare(`INSERT INTO payment_attempts (id, invoice_id, attempt_number, generation, amount_cents,
      currency, method_version, idempotency_key, created_at, updated_at)
      SELECT c.invoice_id || ':attempt:' || (c.attempts_used + 1), c.invoice_id, c.attempts_used + 1,
      c.generation, b.total_cents - b.credited_cents - b.paid_cents, c.currency, m.version,
      c.invoice_id || ':attempt:' || (c.attempts_used + 1), ?4, ?4
      FROM payment_collections c JOIN payment_balances b ON b.invoice_id = c.invoice_id
      JOIN payment_methods m ON m.customer_id = b.customer_id
      WHERE c.invoice_id = ?1 AND c.generation = ?2 AND c.owner_id = ?3 AND c.owner_active = 1
      AND c.has_conflict = 0 AND c.attempts_used < 4 AND b.reserved_cents = 0
      AND ((c.attempts_used = 0 AND ?5 IS NULL) OR EXISTS (
        SELECT 1 FROM payment_attempts previous WHERE previous.invoice_id = c.invoice_id
        AND previous.attempt_number = c.attempts_used AND previous.id = ?5
        AND previous.state = ?6 AND previous.decline_type IS ?7))
      AND NOT EXISTS (SELECT 1 FROM payment_attempts previous
        WHERE previous.invoice_id = c.invoice_id AND previous.attempt_number = c.attempts_used
        AND previous.decline_type = 'soft' AND NOT EXISTS (
          SELECT 1 FROM payment_timeline notice WHERE notice.invoice_id = c.invoice_id
          AND notice.attempt_number = previous.attempt_number AND notice.kind = 'retry_scheduled'
          AND notice.deadline_at IS NOT NULL AND notice.deadline_at <= ?4))
      AND b.total_cents - b.credited_cents - b.paid_cents > 0
      AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE invoice_id = c.invoice_id AND state <> 'declined')
      AND NOT EXISTS (SELECT 1 FROM payment_attempts WHERE invoice_id = c.invoice_id
        AND decline_type = 'hard' AND method_version >= m.version)`)
      .bind(
        ...ownerValues(owner),
        now.toISOString(),
        expectedPreviousAttempt?.id ?? null,
        expectedPreviousAttempt?.state ?? null,
        expectedPreviousAttempt?.declineType ?? null
      ),
    settleStatement(db, owner, now),
    db
      .prepare(`${COLLECTION_SELECT} WHERE c.invoice_id = ?`)
      .bind(owner.invoiceId),
    db
      .prepare(`${ATTEMPT_SELECT} WHERE invoice_id = ? ORDER BY attempt_number`)
      .bind(owner.invoiceId),
    db
      .prepare(
        `${TIMELINE_SELECT} WHERE invoice_id = ? ORDER BY created_at, rowid`
      )
      .bind(owner.invoiceId)
  ]);
  const collection = (collections.results as PaymentCollection[])[0];
  if (!collection) throw new BillingError("conflict", "stale collection owner");
  const c: PaymentDetail = {
    ...collection,
    attempts: attempts.results as PaymentAttempt[],
    timeline: timeline.results as PaymentTimelineEntry[]
  };
  assertOwner(c, owner);
  if (c.hasConflict) return { kind: "needs_review", collection: c };
  const unresolved = c.attempts.find(
    (a) => !["succeeded", "declined"].includes(a.state)
  );
  if (inserted.meta.changes > 0 && unresolved)
    return { kind: "attempt", created: true, attempt: unresolved };
  if (c.balanceCents === 0) return { kind: "settled", collection: c };
  if (c.attemptsRemaining === 0 && !unresolved)
    return { kind: "budget_exhausted", collection: c };
  const previous = c.attempts.at(-1);
  if (
    previous?.id !== expectedPreviousAttempt?.id ||
    previous?.state !== expectedPreviousAttempt?.state ||
    previous?.declineType !== expectedPreviousAttempt?.declineType
  )
    return { kind: "reevaluate", collection: c };
  if (unresolved)
    return { kind: "attempt", created: false, attempt: unresolved };
  // A missing/unfinished gate is not evidence that the card deadline expired.
  return { kind: "reevaluate", collection: c };
}

function settleStatement(db: D1Database, owner: CollectionOwner, now: Date) {
  return db
    .prepare(`UPDATE payment_collections SET status = CASE WHEN status = 'paid' THEN 'paid' ELSE 'settled' END,
    updated_at = ?4 WHERE ${ownerGuard} AND has_conflict = 0
    AND EXISTS (SELECT 1 FROM payment_balances WHERE invoice_id = ?1 AND reserved_cents = 0
      AND total_cents - credited_cents - paid_cents = 0)`)
    .bind(...ownerValues(owner), now.toISOString());
}

/** Call only on exhausted attempts or the fixed card-update deadline. SQL rechecks balance/reservations. */
export async function finalizeCollection(
  db: D1Database,
  owner: CollectionOwner,
  now = new Date()
): Promise<PaymentDetail> {
  await db
    .prepare(`UPDATE payment_collections SET status = CASE
    WHEN has_conflict = 1 OR (SELECT reserved_cents FROM payment_balances WHERE invoice_id = ?1) > 0 THEN 'needs_review'
    WHEN (SELECT total_cents - credited_cents - paid_cents FROM payment_balances WHERE invoice_id = ?1) = 0
      THEN CASE WHEN status = 'paid' THEN 'paid' ELSE 'settled' END
    ELSE 'past_due' END, updated_at = ?4 WHERE ${ownerGuard}`)
    .bind(...ownerValues(owner), now.toISOString())
    .run();
  const c = await getPaymentCollection(db, owner.invoiceId);
  assertOwner(c, owner);
  return c;
}

/** Temporary uncertainty and exhausted recovery never release money. Terminal states cannot regress. */
export async function markPaymentUncertain(
  db: D1Database,
  owner: CollectionOwner,
  attemptId: string,
  state: "recovering" | "needs_review",
  now = new Date()
): Promise<PaymentDetail> {
  if (state !== "recovering" && state !== "needs_review")
    throw new BillingError("invalid", "invalid uncertainty state");
  await db.batch([
    db
      .prepare(`UPDATE payment_attempts SET state = ?5, updated_at = ?6 WHERE id = ?4 AND invoice_id = ?1
      AND state NOT IN ('succeeded', 'declined') AND (state <> 'needs_review' OR ?5 = 'needs_review')
      AND EXISTS (SELECT 1 FROM payment_collections WHERE ${ownerGuard} AND has_conflict = 0)`)
      .bind(
        ...ownerValues(owner),
        text(attemptId, "attemptId"),
        state,
        now.toISOString()
      ),
    db
      .prepare(`UPDATE payment_collections SET status = ?5, updated_at = ?6 WHERE ${ownerGuard} AND has_conflict = 0
      AND EXISTS (SELECT 1 FROM payment_attempts WHERE id = ?4 AND invoice_id = ?1 AND state = ?5)`)
      .bind(...ownerValues(owner), attemptId, state, now.toISOString())
  ]);
  const c = await getPaymentCollection(db, owner.invoiceId);
  assertOwner(c, owner);
  return c;
}

/** Idempotent notice/deadline per caller-supplied ID (use invoice/attempt/kind).
 * Dunning/card notices are additionally unique per attempt/kind, even under different IDs.
 * Replays return the original deadline; they never extend it. Timing is the Workflow's responsibility.
 */
export async function recordCollectionNotice(
  db: D1Database,
  owner: CollectionOwner,
  input: {
    id: string;
    attemptNumber: number;
    kind: "retry_scheduled" | "card_update_requested" | "recovery_check";
    message: string;
    deadlineAt?: string;
  },
  now = new Date()
): Promise<PaymentTimelineEntry> {
  text(input.id, "id");
  integer(input.attemptNumber, "attemptNumber");
  text(input.message, "message");
  if (
    !["retry_scheduled", "card_update_requested", "recovery_check"].includes(
      input.kind
    )
  )
    throw new BillingError("invalid", "invalid notice kind");
  const deadline =
    input.deadlineAt === undefined ? null : new Date(input.deadlineAt);
  if (deadline && Number.isNaN(deadline.getTime()))
    throw new BillingError("invalid", "invalid deadlineAt");
  await db
    .prepare(`INSERT INTO payment_timeline (id, invoice_id, generation, attempt_number, kind, message, deadline_at, created_at)
    SELECT ?4, invoice_id, generation, ?5, ?6, ?7, ?8, ?9 FROM payment_collections
    WHERE ${ownerGuard} AND EXISTS (SELECT 1 FROM payment_attempts WHERE invoice_id = ?1 AND attempt_number = ?5)
    ON CONFLICT DO NOTHING`)
    .bind(
      ...ownerValues(owner),
      input.id,
      input.attemptNumber,
      input.kind,
      input.message,
      deadline?.toISOString() ?? null,
      now.toISOString()
    )
    .run();
  const c = await getPaymentCollection(db, owner.invoiceId);
  assertOwner(c, owner);
  const entry =
    c.timeline.find((e) => e.id === input.id) ??
    (input.kind === "recovery_check"
      ? undefined
      : c.timeline.find(
          (e) =>
            e.attemptNumber === input.attemptNumber && e.kind === input.kind
        ));
  if (
    !entry ||
    entry.attemptNumber !== input.attemptNumber ||
    entry.kind !== input.kind ||
    entry.message !== input.message
  ) {
    throw new BillingError(
      "conflict",
      "notice identity mismatch or missing attempt"
    );
  }
  return entry;
}

/** Only definitive processor observations belong here. Timeout/unavailable/not-found are NOT declines.
 * All fields must match the persisted attempt. Pending observations also bind the processor ID.
 */
export type PaymentOutcome = {
  invoiceId: string;
  attemptId: string;
  idempotencyKey: string;
  processorPaymentId: string;
  amountCents: number;
  currency: "USD";
  methodVersion: number;
} & (
  | { status: "pending" | "succeeded" }
  | { status: "declined"; declineType: "soft" | "hard" }
);
export type ApplyPaymentOutcomeResult = {
  status: "applied" | "duplicate" | "conflict";
  collection: PaymentDetail;
};

function canonicalOutcome(outcome: PaymentOutcome): string {
  if (
    !["pending", "succeeded", "declined"].includes(outcome.status) ||
    outcome.currency !== "USD"
  )
    throw new BillingError("invalid", "invalid processor status or currency");
  if (
    outcome.status === "declined" &&
    !["soft", "hard"].includes(outcome.declineType)
  )
    throw new BillingError("invalid", "declineType required");
  return JSON.stringify({
    invoiceId: text(outcome.invoiceId, "invoiceId"),
    attemptId: text(outcome.attemptId, "attemptId"),
    idempotencyKey: text(outcome.idempotencyKey, "idempotencyKey"),
    processorPaymentId: text(outcome.processorPaymentId, "processorPaymentId"),
    amountCents: integer(outcome.amountCents, "amountCents"),
    currency: outcome.currency,
    methodVersion: integer(outcome.methodVersion, "methodVersion"),
    status: outcome.status,
    ...(outcome.status === "declined"
      ? { declineType: outcome.declineType }
      : {})
  });
}

/** Shared by HTTP results, status lookup and webhook drain; deliberately NOT generation-fenced.
 * Identity is SQL-guarded. A fresh token gates every effect in the same atomic batch.
 * Conflicting terminal observations quarantine collection without reversing the first posting/release.
 */
export async function applyPaymentOutcome(
  db: D1Database,
  outcome: PaymentOutcome,
  options: { eventId?: string; now?: Date } = {}
): Promise<ApplyPaymentOutcomeResult> {
  const payload = canonicalOutcome(outcome);
  const now = (options.now ?? new Date()).toISOString();
  const token = crypto.randomUUID();
  const eventId =
    options.eventId === undefined ? null : text(options.eventId, "eventId");
  const decline = outcome.status === "declined" ? outcome.declineType : null;
  const identity = `id = ?1 AND invoice_id = ?2 AND idempotency_key = ?3 AND amount_cents = ?4
    AND currency = ?5 AND method_version = ?6 AND (processor_payment_id IS NULL OR processor_payment_id = ?7)
    AND NOT EXISTS (SELECT 1 FROM payment_attempts other WHERE other.processor_payment_id = ?7 AND other.id <> ?1)
    AND (?8 IS NULL OR EXISTS (SELECT 1 FROM payment_webhook_inbox WHERE event_id = ?8 AND payload = ?9))`;
  const identityValues = [
    outcome.attemptId,
    outcome.invoiceId,
    outcome.idempotencyKey,
    outcome.amountCents,
    outcome.currency,
    outcome.methodVersion,
    outcome.processorPaymentId,
    eventId,
    payload
  ];
  const contradictory = `(state IN ('succeeded', 'declined') AND ?10 <> 'pending'
    AND (state <> ?10 OR (state = 'declined' AND decline_type IS NOT ?11)))`;
  const selected = `SELECT * FROM payment_attempts WHERE id = ?1 AND outcome_token = ?2`;
  const [before, changed] = await db.batch([
    db
      .prepare(
        `SELECT state, decline_type, conflicted FROM payment_attempts WHERE ${identity}`
      )
      .bind(...identityValues),
    db
      .prepare(`UPDATE payment_attempts SET
      conflicted = CASE WHEN ${contradictory} THEN 1 ELSE conflicted END,
      processor_payment_id = ?7, outcome_token = ?12,
      decline_type = CASE WHEN state IN ('succeeded', 'declined') THEN decline_type ELSE ?11 END,
      state = CASE WHEN state IN ('succeeded', 'declined') THEN state
        WHEN ?10 = 'pending' AND state IN ('recovering', 'needs_review') THEN state ELSE ?10 END,
      updated_at = ?13 WHERE ${identity}`)
      .bind(...identityValues, outcome.status, decline, token, now),
    db
      .prepare(`INSERT INTO payments (processor_payment_id, attempt_id, invoice_id, customer_id, amount_cents, currency, created_at)
      SELECT a.processor_payment_id, a.id, a.invoice_id, i.customer_id, a.amount_cents, a.currency, ?3
      FROM (${selected}) a JOIN invoices i ON i.id = a.invoice_id
      JOIN payment_reservations r ON r.attempt_id = a.id
      WHERE a.state = 'succeeded' AND a.conflicted = 0 AND r.status = 'reserved'
      ON CONFLICT (processor_payment_id) DO NOTHING`)
      .bind(outcome.attemptId, token, now),
    ...(["cash", "accounts_receivable"] as const).map((account) =>
      db
        .prepare(`INSERT INTO ledger_entries
      (transaction_id, account, customer_id, amount_cents, description, created_at)
      SELECT 'payment:' || p.processor_payment_id, ?3, p.customer_id, p.amount_cents * ?4,
      'Payment ' || p.processor_payment_id || ' on ' || p.invoice_id, p.created_at
      FROM payments p JOIN (${selected}) a ON a.id = p.attempt_id
      ON CONFLICT (transaction_id, account) DO NOTHING`)
        .bind(outcome.attemptId, token, account, account === "cash" ? 1 : -1)
    ),
    db
      .prepare(`UPDATE payment_reservations SET status = CASE
        WHEN EXISTS (SELECT 1 FROM payments WHERE attempt_id = ?1) THEN 'converted' ELSE 'released' END, resolved_at = ?3
      WHERE attempt_id = ?1 AND status = 'reserved' AND EXISTS (${selected}
        AND conflicted = 0 AND (state = 'declined' OR (state = 'succeeded' AND EXISTS (SELECT 1 FROM payments WHERE attempt_id = ?1))))`)
      .bind(outcome.attemptId, token, now),
    db
      .prepare(`UPDATE payment_collections SET
      has_conflict = CASE WHEN EXISTS (${selected} AND conflicted = 1) THEN 1 ELSE has_conflict END,
      status = CASE
        WHEN has_conflict = 1 OR EXISTS (${selected} AND conflicted = 1) THEN 'needs_review'
        WHEN EXISTS (SELECT 1 FROM payment_balances b WHERE b.invoice_id = payment_collections.invoice_id
          AND b.total_cents - b.credited_cents - b.paid_cents = 0 AND b.reserved_cents = 0)
          THEN CASE WHEN EXISTS (SELECT 1 FROM payments WHERE invoice_id = payment_collections.invoice_id) THEN 'paid' ELSE 'settled' END
        WHEN attempts_used = (SELECT attempt_number FROM payment_attempts WHERE id = ?1)
          AND status IN ('processing', 'recovering', 'needs_review')
          AND EXISTS (${selected} AND state = 'declined')
          THEN CASE WHEN attempts_used = 4 THEN 'past_due'
            WHEN (SELECT decline_type FROM payment_attempts WHERE id = ?1) = 'hard' THEN 'action_required' ELSE 'retrying' END
        ELSE status END, updated_at = ?3
      WHERE invoice_id = (SELECT invoice_id FROM payment_attempts WHERE id = ?1 AND outcome_token = ?2)`)
      .bind(outcome.attemptId, token, now),
    db
      .prepare(`INSERT INTO payment_timeline (id, invoice_id, generation, attempt_number, kind, message, created_at)
      SELECT 'outcome:' || a.id || ':' || ?3 || ':' || COALESCE(?4, ''), a.invoice_id, c.generation,
      a.attempt_number, CASE WHEN a.conflicted = 1 THEN 'outcome_conflict' ELSE 'processor_' || ?3 END,
      a.processor_payment_id, ?5 FROM (${selected}) a JOIN payment_collections c ON c.invoice_id = a.invoice_id
      ON CONFLICT (id) DO NOTHING`)
      .bind(outcome.attemptId, token, outcome.status, decline, now),
    db
      .prepare(`UPDATE payment_webhook_inbox SET applied_at = ?3,
      application_result = CASE WHEN EXISTS (${selected} AND conflicted = 1) THEN 'conflict' ELSE 'applied' END
      WHERE event_id = ?4 AND applied_at IS NULL AND EXISTS (${selected})`)
      .bind(outcome.attemptId, token, now, eventId)
  ]);
  if (!changed.meta.changes)
    throw new BillingError(
      "conflict",
      "processor outcome does not match attempt identity or durable inbox payload"
    );
  const c = await getPaymentCollection(db, outcome.invoiceId);
  const attempt = c.attempts.find((a) => a.id === outcome.attemptId)!;
  const prior = before.results[0] as {
    state: AttemptState;
    decline_type: string | null;
    conflicted: number;
  };
  return {
    status: attempt.conflicted
      ? "conflict"
      : prior.state === outcome.status ||
          ["succeeded", "declined"].includes(prior.state)
        ? "duplicate"
        : "applied",
    collection: c
  };
}

export type PaymentInboxEvent = {
  eventId: string;
  outcome: PaymentOutcome;
  receivedAt: string;
  appliedAt: string | null;
  applicationResult: "applied" | "conflict" | null;
  notifiedAt: string | null;
};

/** Call only after verifying the processor signature. Receipt and application are independently durable. */
export async function receivePaymentWebhook(
  db: D1Database,
  eventId: string,
  outcome: PaymentOutcome,
  now = new Date()
): Promise<{ status: "received" | "duplicate" }> {
  const payload = canonicalOutcome(outcome);
  text(eventId, "eventId");
  const result = await db
    .prepare(`INSERT INTO payment_webhook_inbox (event_id, payload, received_at)
    VALUES (?, ?, ?) ON CONFLICT (event_id) DO NOTHING`)
    .bind(eventId, payload, now.toISOString())
    .run();
  const stored = await db
    .prepare("SELECT payload FROM payment_webhook_inbox WHERE event_id = ?")
    .bind(eventId)
    .first<{ payload: string }>();
  if (stored?.payload !== payload)
    throw new BillingError(
      "conflict",
      "webhook event ID reused with different payload"
    );
  return { status: result.meta.changes ? "received" : "duplicate" };
}

export async function listPaymentInbox(
  db: D1Database,
  unappliedOnly = true
): Promise<PaymentInboxEvent[]> {
  const { results } = await db
    .prepare(`SELECT event_id AS eventId, payload, received_at AS receivedAt,
    applied_at AS appliedAt, application_result AS applicationResult, notified_at AS notifiedAt
    FROM payment_webhook_inbox ${unappliedOnly ? "WHERE applied_at IS NULL" : ""} ORDER BY received_at, event_id`)
    .all<Omit<PaymentInboxEvent, "outcome"> & { payload: string }>();
  return results.map(({ payload, ...event }) => ({
    ...event,
    outcome: JSON.parse(payload) as PaymentOutcome
  }));
}

export async function applyPaymentWebhook(
  db: D1Database,
  eventId: string,
  now = new Date()
): Promise<ApplyPaymentOutcomeResult> {
  const event = await db
    .prepare(
      "SELECT payload, applied_at, application_result FROM payment_webhook_inbox WHERE event_id = ?"
    )
    .bind(text(eventId, "eventId"))
    .first<{
      payload: string;
      applied_at: string | null;
      application_result: string | null;
    }>();
  if (!event) throw new BillingError("not_found", "unknown webhook event");
  const outcome = JSON.parse(event.payload) as PaymentOutcome;
  if (event.applied_at)
    return {
      status:
        event.application_result === "conflict" ? "conflict" : "duplicate",
      collection: await getPaymentCollection(db, outcome.invoiceId)
    };
  return applyPaymentOutcome(db, outcome, { eventId, now });
}

/** Notification is only a hint; failure to send it never rolls back application. */
export async function markPaymentWebhookNotified(
  db: D1Database,
  eventId: string,
  now = new Date()
): Promise<void> {
  await db
    .prepare(
      "UPDATE payment_webhook_inbox SET notified_at = COALESCE(notified_at, ?) WHERE event_id = ? AND applied_at IS NOT NULL"
    )
    .bind(now.toISOString(), text(eventId, "eventId"))
    .run();
}

export async function listUnresolvedPaymentAttempts(
  db: D1Database
): Promise<PaymentAttempt[]> {
  const { results } = await db
    .prepare(
      `${ATTEMPT_SELECT} WHERE state NOT IN ('succeeded', 'declined') ORDER BY created_at, id`
    )
    .all<PaymentAttempt>();
  return results;
}

/** Internal checks only. The recovery service must additionally compare processor records by original key/ID. */
export async function reconcilePayments(
  db: D1Database
): Promise<ReconciliationIssue[]> {
  const checks = [
    {
      check: "payment_not_posted",
      sql: `SELECT p.processor_payment_id AS reference FROM payments p
      LEFT JOIN ledger_entries cash ON cash.transaction_id = 'payment:' || p.processor_payment_id AND cash.account = 'cash'
      LEFT JOIN ledger_entries ar ON ar.transaction_id = 'payment:' || p.processor_payment_id AND ar.account = 'accounts_receivable'
      WHERE cash.amount_cents IS NOT p.amount_cents OR ar.amount_cents IS NOT -p.amount_cents
        OR cash.customer_id IS NOT p.customer_id OR ar.customer_id IS NOT p.customer_id`
    },
    {
      check: "payment_reservation_mismatch",
      sql: `SELECT a.id AS reference FROM payment_attempts a
      LEFT JOIN payment_reservations r ON r.attempt_id = a.id LEFT JOIN payments p ON p.attempt_id = a.id
      WHERE r.amount_cents IS NOT a.amount_cents OR r.invoice_id IS NOT a.invoice_id
        OR (a.state NOT IN ('succeeded', 'declined') AND r.status IS NOT 'reserved')
        OR (a.state = 'declined' AND (r.status IS NOT 'released' OR p.attempt_id IS NOT NULL))
        OR (a.state = 'succeeded' AND (r.status IS NOT 'converted' OR p.amount_cents IS NOT a.amount_cents
          OR p.invoice_id IS NOT a.invoice_id OR p.currency IS NOT a.currency OR p.processor_payment_id IS NOT a.processor_payment_id))`
    },
    {
      check: "payment_overallocated",
      sql: `SELECT invoice_id AS reference FROM payment_balances
      WHERE credited_cents + paid_cents + reserved_cents > total_cents`
    },
    {
      check: "payment_budget_mismatch",
      sql: `SELECT c.invoice_id AS reference FROM payment_collections c
      WHERE c.attempts_used <> (SELECT COUNT(*) FROM payment_attempts WHERE invoice_id = c.invoice_id)`
    },
    {
      check: "payment_outcome_conflict",
      sql: "SELECT id AS reference FROM payment_attempts WHERE conflicted = 1"
    },
    {
      check: "payment_orphan_posting",
      sql: `SELECT DISTINCT transaction_id AS reference FROM ledger_entries e
      WHERE (account = 'cash' OR transaction_id LIKE 'payment:%')
      AND NOT EXISTS (SELECT 1 FROM payments p WHERE 'payment:' || p.processor_payment_id = e.transaction_id)`
    }
  ];
  const results = await db.batch(checks.map((c) => db.prepare(c.sql)));
  return results.flatMap((r, i) =>
    (r.results as { reference: string }[]).map(({ reference }) => ({
      check: checks[i].check,
      reference,
      detail: checks[i].check.replaceAll("_", " ")
    }))
  );
}
