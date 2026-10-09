/**
 * Billing operations on the shared D1 database, the source of truth for all
 * customers. D1 cannot hold a transaction open across awaits, so every write
 * is a single statement or one atomic db.batch(), with SQL guards and unique
 * constraints making retries and concurrent calls safe.
 */
import { reconcilePayments } from "./payments.ts";
import {
  buildInvoiceLines,
  formatCents,
  type InvoiceLine,
  type Meter,
  type Plan,
  type PriceTier
} from "./pricing.ts";

export type BillingErrorCode =
  | "invalid"
  | "not_found"
  | "conflict"
  | "period_closed"
  | "period_open";

export class BillingError extends Error {
  readonly code: BillingErrorCode;

  constructor(code: BillingErrorCode, message: string) {
    super(message);
    this.name = "BillingError";
    this.code = code;
  }
}

// ── Time ──────────────────────────────────────────────────────────────

/**
 * All timestamps are stored as UTC ISO-8601 strings with milliseconds, so
 * string comparison in SQL matches chronological order.
 */
function toTimestamp(value: string, field: string): string {
  const date = new Date(value);
  const year = date.getUTCFullYear();
  if (Number.isNaN(date.getTime()) || year < 2000 || year > 9999) {
    throw new BillingError("invalid", `${field} must be a valid ISO-8601 date`);
  }
  return date.toISOString();
}

/** Monthly billing period in UTC: [start, end). */
export function monthPeriod(month: string): { start: string; end: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match) throw new BillingError("invalid", "month must be YYYY-MM");
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  // Both boundaries must stay in our supported four-digit ISO year range.
  // Expanded +010000 timestamps sort before ordinary dates in JS and SQL;
  // years below 100 also have special Date.UTC semantics.
  if (year < 2000 || (year === 9999 && index === 11)) {
    throw new BillingError(
      "invalid",
      "month must be between 2000-01 and 9999-11"
    );
  }
  return {
    start: new Date(Date.UTC(year, index, 1)).toISOString(),
    end: new Date(Date.UTC(year, index + 1, 1)).toISOString()
  };
}

/**
 * There is no proration, so billing starts with the first full month after
 * the customer was created (or that month if created on the 1st at 00:00).
 */
export function firstBillableMonth(createdAt: string): string {
  const created = new Date(createdAt);
  const startOfMonth = Date.UTC(
    created.getUTCFullYear(),
    created.getUTCMonth(),
    1
  );
  const first =
    created.getTime() === startOfMonth
      ? created
      : new Date(
          Date.UTC(created.getUTCFullYear(), created.getUTCMonth() + 1, 1)
        );
  return first.toISOString().slice(0, 7);
}

function requireText(value: unknown, field: string, maxLength = 200): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new BillingError(
      "invalid",
      `${field} must be a non-empty string of at most ${maxLength} characters`
    );
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new BillingError("invalid", `${field} must be a positive integer`);
  }
  return value;
}

// ── Usage ingestion ───────────────────────────────────────────────────

export type UsageEventInput = {
  /** Producer-supplied idempotency key */
  id: string;
  customerId: string;
  meterId: string;
  quantity: number;
  occurredAt: string;
};

/**
 * Records one usage event exactly once. Resending the same event is a no-op;
 * reusing its id with different data is a conflict. Events for a period that
 * already has an invoice are rejected so invoices never miss usage.
 */
export async function recordUsage(
  db: D1Database,
  input: UsageEventInput,
  now = new Date()
): Promise<{ status: "recorded" | "duplicate" }> {
  const id = requireText(input.id, "id");
  const customerId = requireText(input.customerId, "customerId");
  const meterId = requireText(input.meterId, "meterId");
  const quantity = requirePositiveInteger(input.quantity, "quantity");
  const occurredAt = toTimestamp(input.occurredAt, "occurredAt");
  if (occurredAt > now.toISOString()) {
    throw new BillingError("invalid", "occurredAt is in the future");
  }

  let changes: number;
  try {
    // The period check and the insert are one statement, so an invoice cannot
    // close the period between them.
    const result = await db
      .prepare(
        `INSERT INTO usage_events (id, customer_id, meter_id, quantity, occurred_at, received_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE NOT EXISTS (
           SELECT 1 FROM invoices
           WHERE customer_id = ?2 AND period_start <= ?5 AND period_end > ?5
         )
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(id, customerId, meterId, quantity, occurredAt, now.toISOString())
      .run();
    changes = result.meta.changes;
  } catch (error) {
    if (String(error).includes("FOREIGN KEY")) {
      throw new BillingError(
        "not_found",
        `unknown customer "${customerId}" or meter "${meterId}"`
      );
    }
    throw error;
  }
  if (changes === 1) return { status: "recorded" };

  const existing = await db
    .prepare(
      "SELECT customer_id, meter_id, quantity, occurred_at FROM usage_events WHERE id = ?"
    )
    .bind(id)
    .first<{
      customer_id: string;
      meter_id: string;
      quantity: number;
      occurred_at: string;
    }>();
  if (!existing) {
    throw new BillingError(
      "period_closed",
      `usage at ${occurredAt} falls in a period that is already invoiced`
    );
  }
  const same =
    existing.customer_id === customerId &&
    existing.meter_id === meterId &&
    existing.quantity === quantity &&
    existing.occurred_at === occurredAt;
  if (!same) {
    throw new BillingError(
      "conflict",
      `usage event "${id}" was already recorded with different data`
    );
  }
  return { status: "duplicate" };
}

// ── Invoicing ─────────────────────────────────────────────────────────

export type Invoice = {
  id: string;
  customerId: string;
  planId: string;
  periodStart: string;
  periodEnd: string;
  status: "draft" | "finalized";
  totalCents: number | null;
  createdAt: string;
  finalizedAt: string | null;
};

type InvoiceRow = {
  id: string;
  customer_id: string;
  plan_id: string;
  period_start: string;
  period_end: string;
  status: "draft" | "finalized";
  total_cents: number | null;
  created_at: string;
  finalized_at: string | null;
};

const toInvoice = (row: InvoiceRow): Invoice => ({
  id: row.id,
  customerId: row.customer_id,
  planId: row.plan_id,
  periodStart: row.period_start,
  periodEnd: row.period_end,
  status: row.status,
  totalCents: row.total_cents,
  createdAt: row.created_at,
  finalizedAt: row.finalized_at
});

async function findInvoice(
  db: D1Database,
  invoiceId: string
): Promise<Invoice | null> {
  const row = await db
    .prepare("SELECT * FROM invoices WHERE id = ?")
    .bind(invoiceId)
    .first<InvoiceRow>();
  return row ? toInvoice(row) : null;
}

export const invoiceIdFor = (customerId: string, month: string) =>
  `inv_${customerId}_${month}`;

/**
 * Step 1 of invoicing: creates the draft invoice for an ended month, which
 * closes that period to new usage. Idempotent: returns the existing invoice
 * if it was already opened. The customer's plan is snapshotted on the invoice.
 * Months before the customer's first full month cannot be invoiced.
 */
export async function openInvoice(
  db: D1Database,
  customerId: string,
  month: string,
  now = new Date()
): Promise<Invoice> {
  const period = monthPeriod(month);
  if (period.end > now.toISOString()) {
    throw new BillingError("period_open", `${month} has not ended yet`);
  }
  const id = invoiceIdFor(customerId, month);
  await db
    .prepare(
      `INSERT INTO invoices (id, customer_id, plan_id, period_start, period_end, status, created_at)
       SELECT ?1, id, plan_id, ?3, ?4, 'draft', ?5 FROM customers
       WHERE id = ?2 AND created_at <= ?3
       ON CONFLICT DO NOTHING`
    )
    .bind(id, customerId, period.start, period.end, now.toISOString())
    .run();
  const invoice = await findInvoice(db, id);
  if (invoice) return invoice;
  const customer = await db
    .prepare("SELECT created_at FROM customers WHERE id = ?")
    .bind(customerId)
    .first<{ created_at: string }>();
  if (!customer) {
    throw new BillingError("not_found", `unknown customer "${customerId}"`);
  }
  throw new BillingError(
    "invalid",
    `billing for this customer starts in ${firstBillableMonth(customer.created_at)}`
  );
}

/**
 * Step 2 of invoicing: prices the period's usage, writes the invoice lines,
 * and posts the receivable to the ledger in one atomic batch. Every write is
 * guarded on the invoice still being a draft, so retries and concurrent runs
 * finalize it exactly once.
 */
export async function finalizeInvoice(
  db: D1Database,
  invoiceId: string,
  now = new Date()
): Promise<Invoice> {
  const invoice = await findInvoice(db, invoiceId);
  if (!invoice) {
    throw new BillingError("not_found", `unknown invoice "${invoiceId}"`);
  }
  if (invoice.status === "finalized") return invoice;

  // Usage for the period is frozen: the draft invoice blocks new events.
  const [plans, meters, tiers, usage] = await db.batch([
    db
      .prepare(
        "SELECT id, name, monthly_fee_cents AS monthlyFeeCents FROM plans WHERE id = ?"
      )
      .bind(invoice.planId),
    db.prepare("SELECT id, name, unit FROM meters"),
    db
      .prepare(
        `SELECT meter_id AS meterId, from_quantity AS fromQuantity,
                unit_price_micros AS unitPriceMicros, block_size AS blockSize
         FROM price_tiers WHERE plan_id = ?`
      )
      .bind(invoice.planId),
    db
      .prepare(
        `SELECT meter_id AS meterId, SUM(quantity) AS quantity FROM usage_events
         WHERE customer_id = ? AND occurred_at >= ? AND occurred_at < ?
         GROUP BY meter_id`
      )
      .bind(invoice.customerId, invoice.periodStart, invoice.periodEnd)
  ]);
  const plan = (plans.results as Plan[])[0];
  const usageByMeter = Object.fromEntries(
    (usage.results as { meterId: string; quantity: number }[]).map((u) => [
      u.meterId,
      u.quantity
    ])
  );
  const lines = buildInvoiceLines({
    plan,
    meters: meters.results as Meter[],
    tiers: tiers.results as PriceTier[],
    usage: usageByMeter
  });
  const totalCents = lines.reduce((sum, line) => sum + line.amountCents, 0);
  const finalizedAt = now.toISOString();
  const isDraft =
    "EXISTS (SELECT 1 FROM invoices WHERE id = ?7 AND status = 'draft')";

  const statements = lines.map((line) => insertLine(db, invoiceId, line));
  if (totalCents > 0) {
    const transactionId = `invoice:${invoiceId}`;
    const description = `Invoice ${invoiceId}`;
    statements.push(
      postEntry(db, isDraft, invoiceId, {
        transactionId,
        account: "accounts_receivable",
        customerId: invoice.customerId,
        amountCents: totalCents,
        description,
        createdAt: finalizedAt
      }),
      postEntry(db, isDraft, invoiceId, {
        transactionId,
        account: "revenue",
        customerId: invoice.customerId,
        amountCents: -totalCents,
        description,
        createdAt: finalizedAt
      })
    );
  }
  // Last, so the guards above still see the draft status
  statements.push(
    db
      .prepare(
        `UPDATE invoices SET status = 'finalized', total_cents = ?2, finalized_at = ?3
         WHERE id = ?1 AND status = 'draft'`
      )
      .bind(invoiceId, totalCents, finalizedAt)
  );
  await db.batch(statements);

  // If a concurrent run finalized first, this batch changed nothing and the
  // stored invoice (priced from the same frozen usage) is returned.
  return (await findInvoice(db, invoiceId)) as Invoice;
}

function insertLine(db: D1Database, invoiceId: string, line: InvoiceLine) {
  return db
    .prepare(
      `INSERT INTO invoice_lines (invoice_id, line_no, kind, meter_id, description,
         quantity, unit_price_micros, block_size, amount_cents)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
       WHERE EXISTS (SELECT 1 FROM invoices WHERE id = ?1 AND status = 'draft')`
    )
    .bind(
      invoiceId,
      line.lineNo,
      line.kind,
      line.meterId,
      line.description,
      line.quantity,
      line.unitPriceMicros,
      line.blockSize,
      line.amountCents
    );
}

type LedgerEntryInput = {
  transactionId: string;
  account: "accounts_receivable" | "revenue" | "credits_issued";
  customerId: string;
  /** Debit positive, credit negative */
  amountCents: number;
  description: string;
  createdAt: string;
};

/** Inserts a ledger entry only if `guard` (which may use ?7) holds. */
function postEntry(
  db: D1Database,
  guard: string,
  guardParam: string,
  entry: LedgerEntryInput
) {
  return db
    .prepare(
      `INSERT INTO ledger_entries (transaction_id, account, customer_id, amount_cents, description, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6 WHERE ${guard}
       ON CONFLICT (transaction_id, account) DO NOTHING`
    )
    .bind(
      entry.transactionId,
      entry.account,
      entry.customerId,
      entry.amountCents,
      entry.description,
      entry.createdAt,
      guardParam
    );
}

// ── Credits ───────────────────────────────────────────────────────────

export type CreditInput = {
  /** Caller-supplied idempotency key */
  id: string;
  invoiceId: string;
  amountCents: number;
  reason: string;
  /** Who approved the credit; the assistant may only propose credits */
  approvedBy: string;
};

export type Credit = CreditInput & { customerId: string; createdAt: string };

/**
 * Issues a credit against a finalized invoice. The credit and its ledger
 * entries are written atomically. The SQL guard subtracts credits, posted
 * payments and unresolved reservations, including those held for review.
 */
export async function issueCredit(
  db: D1Database,
  input: CreditInput,
  now = new Date()
): Promise<{ status: "issued" | "duplicate"; credit: Credit }> {
  const id = requireText(input.id, "id");
  const invoiceId = requireText(input.invoiceId, "invoiceId");
  const amountCents = requirePositiveInteger(input.amountCents, "amountCents");
  const reason = requireText(input.reason, "reason", 500);
  const approvedBy = requireText(input.approvedBy, "approvedBy");
  const createdAt = now.toISOString();
  const transactionId = `credit:${id}`;
  const description = `Credit ${id} on ${invoiceId}: ${reason}`;

  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO credits (id, invoice_id, customer_id, amount_cents, reason, approved_by, created_at)
         SELECT ?1, i.id, i.customer_id, ?3, ?4, ?5, ?6 FROM invoices i
         WHERE i.id = ?2 AND i.status = 'finalized'
           AND EXISTS (SELECT 1 FROM payment_balances b WHERE b.invoice_id = i.id
             AND b.total_cents - b.credited_cents - b.paid_cents - b.reserved_cents >= ?3)
         ON CONFLICT (id) DO NOTHING`
      )
      .bind(id, invoiceId, amountCents, reason, approvedBy, createdAt),
    // On a retry these are no-ops thanks to the unique (transaction, account)
    db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account, customer_id, amount_cents, description, created_at)
         SELECT ?1, 'credits_issued', customer_id, amount_cents, ?2, ?3 FROM credits WHERE id = ?4
         ON CONFLICT (transaction_id, account) DO NOTHING`
      )
      .bind(transactionId, description, createdAt, id),
    db
      .prepare(
        `INSERT INTO ledger_entries (transaction_id, account, customer_id, amount_cents, description, created_at)
         SELECT ?1, 'accounts_receivable', customer_id, -amount_cents, ?2, ?3 FROM credits WHERE id = ?4
         ON CONFLICT (transaction_id, account) DO NOTHING`
      )
      .bind(transactionId, description, createdAt, id)
  ]);

  const row = await db
    .prepare("SELECT * FROM credits WHERE id = ?")
    .bind(id)
    .first<{
      id: string;
      invoice_id: string;
      customer_id: string;
      amount_cents: number;
      reason: string;
      approved_by: string;
      created_at: string;
    }>();
  if (!row) {
    const invoice = await findInvoice(db, invoiceId);
    if (!invoice) {
      throw new BillingError("not_found", `unknown invoice "${invoiceId}"`);
    }
    if (invoice.status !== "finalized") {
      throw new BillingError(
        "conflict",
        `invoice "${invoiceId}" is not finalized`
      );
    }
    const balance = await db
      .prepare(
        `SELECT total_cents - credited_cents - paid_cents - reserved_cents AS cents
         FROM payment_balances WHERE invoice_id = ?`
      )
      .bind(invoiceId)
      .first<{ cents: number }>();
    const remaining = balance?.cents ?? 0;
    throw new BillingError(
      "conflict",
      `credit exceeds the remaining creditable amount on "${invoiceId}": only ${formatCents(remaining)} can still be credited`
    );
  }
  if (row.invoice_id !== invoiceId || row.amount_cents !== amountCents) {
    throw new BillingError(
      "conflict",
      `credit "${id}" was already issued with different data`
    );
  }
  return {
    status: inserted.meta.changes > 0 ? "issued" : "duplicate",
    credit: {
      id: row.id,
      invoiceId: row.invoice_id,
      customerId: row.customer_id,
      amountCents: row.amount_cents,
      reason: row.reason,
      approvedBy: row.approved_by,
      createdAt: row.created_at
    }
  };
}

// ── Reads ─────────────────────────────────────────────────────────────

export type CustomerSummary = {
  id: string;
  name: string;
  email: string;
  planId: string;
  planName: string;
  createdAt: string;
  /** Accounts-receivable balance: positive means the customer owes money */
  balanceCents: number;
};

const CUSTOMER_SUMMARY_SQL = `
  SELECT c.id, c.name, c.email, c.plan_id AS planId, p.name AS planName,
    c.created_at AS createdAt,
    COALESCE((
      SELECT SUM(amount_cents) FROM ledger_entries
      WHERE customer_id = c.id AND account = 'accounts_receivable'
    ), 0) AS balanceCents
  FROM customers c JOIN plans p ON p.id = c.plan_id`;

export async function listCustomers(
  db: D1Database
): Promise<CustomerSummary[]> {
  const { results } = await db
    .prepare(`${CUSTOMER_SUMMARY_SQL} ORDER BY c.name`)
    .all<CustomerSummary>();
  return results;
}

export async function getCustomer(
  db: D1Database,
  customerId: string
): Promise<CustomerSummary> {
  const customer = await db
    .prepare(`${CUSTOMER_SUMMARY_SQL} WHERE c.id = ?`)
    .bind(customerId)
    .first<CustomerSummary>();
  if (!customer) {
    throw new BillingError("not_found", `unknown customer "${customerId}"`);
  }
  return customer;
}

export type MeterUsage = {
  meterId: string;
  name: string;
  unit: string;
  quantity: number;
  events: number;
};

/** Usage totals per meter for one month. */
export async function getUsageSummary(
  db: D1Database,
  customerId: string,
  month: string
): Promise<{ month: string; meters: MeterUsage[] }> {
  const period = monthPeriod(month);
  const { results } = await db
    .prepare(
      `SELECT m.id AS meterId, m.name, m.unit,
         COALESCE(SUM(u.quantity), 0) AS quantity, COUNT(u.id) AS events
       FROM meters m
       LEFT JOIN usage_events u ON u.meter_id = m.id AND u.customer_id = ?1
         AND u.occurred_at >= ?2 AND u.occurred_at < ?3
       GROUP BY m.id ORDER BY m.id`
    )
    .bind(customerId, period.start, period.end)
    .all<MeterUsage>();
  return { month, meters: results };
}

export type InvoiceSummary = Invoice & { creditedCents: number };

export async function listInvoices(
  db: D1Database,
  customerId: string
): Promise<InvoiceSummary[]> {
  const { results } = await db
    .prepare(
      `SELECT i.*, COALESCE((
         SELECT SUM(amount_cents) FROM credits WHERE invoice_id = i.id
       ), 0) AS credited_cents
       FROM invoices i WHERE i.customer_id = ? ORDER BY i.period_start DESC`
    )
    .bind(customerId)
    .all<InvoiceRow & { credited_cents: number }>();
  return results.map((row) => ({
    ...toInvoice(row),
    creditedCents: row.credited_cents
  }));
}

export type InvoiceDetail = Invoice & {
  lines: InvoiceLine[];
  credits: Credit[];
};

export async function getInvoice(
  db: D1Database,
  invoiceId: string
): Promise<InvoiceDetail> {
  const [invoices, lines, credits] = await db.batch([
    db.prepare("SELECT * FROM invoices WHERE id = ?").bind(invoiceId),
    db
      .prepare(
        `SELECT line_no AS lineNo, kind, meter_id AS meterId, description, quantity,
           unit_price_micros AS unitPriceMicros, block_size AS blockSize,
           amount_cents AS amountCents
         FROM invoice_lines WHERE invoice_id = ? ORDER BY line_no`
      )
      .bind(invoiceId),
    db
      .prepare(
        `SELECT id, invoice_id AS invoiceId, customer_id AS customerId,
           amount_cents AS amountCents, reason, approved_by AS approvedBy,
           created_at AS createdAt
         FROM credits WHERE invoice_id = ? ORDER BY created_at, id`
      )
      .bind(invoiceId)
  ]);
  const row = (invoices.results as InvoiceRow[])[0];
  if (!row) {
    throw new BillingError("not_found", `unknown invoice "${invoiceId}"`);
  }
  return {
    ...toInvoice(row),
    lines: lines.results as InvoiceLine[],
    credits: credits.results as Credit[]
  };
}

// ── Reconciliation ────────────────────────────────────────────────────

export type ReconciliationIssue = {
  check: string;
  reference: string;
  detail: string;
};

/**
 * Cross-checks internal invoices, credits, payments, reservations and ledger.
 * Processor comparison belongs to the payment recovery service, not this store.
 */
export async function reconcile(
  db: D1Database
): Promise<ReconciliationIssue[]> {
  const [unbalanced, badTotals, unposted, unpostedCredits, overCredited] =
    await db.batch([
      db.prepare(
        `SELECT transaction_id AS reference, SUM(amount_cents) AS amount
         FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_cents) <> 0`
      ),
      db.prepare(
        `SELECT i.id AS reference, i.total_cents AS total,
           COALESCE(SUM(l.amount_cents), 0) AS amount
         FROM invoices i LEFT JOIN invoice_lines l ON l.invoice_id = i.id
         WHERE i.status = 'finalized'
         GROUP BY i.id HAVING i.total_cents <> COALESCE(SUM(l.amount_cents), 0)`
      ),
      db.prepare(
        `SELECT i.id AS reference, i.total_cents AS total,
           COALESCE(e.amount_cents, 0) AS amount
         FROM invoices i
         LEFT JOIN ledger_entries e ON e.transaction_id = 'invoice:' || i.id
           AND e.account = 'accounts_receivable'
         WHERE i.status = 'finalized' AND i.total_cents <> COALESCE(e.amount_cents, 0)`
      ),
      db.prepare(
        `SELECT c.id AS reference, c.amount_cents AS total,
           COALESCE(-e.amount_cents, 0) AS amount
         FROM credits c
         LEFT JOIN ledger_entries e ON e.transaction_id = 'credit:' || c.id
           AND e.account = 'accounts_receivable'
         WHERE c.amount_cents <> COALESCE(-e.amount_cents, 0)`
      ),
      db.prepare(
        `SELECT i.id AS reference, i.total_cents AS total, SUM(c.amount_cents) AS amount
         FROM invoices i JOIN credits c ON c.invoice_id = i.id
         GROUP BY i.id HAVING SUM(c.amount_cents) > i.total_cents`
      )
    ]);
  type Row = { reference: string; amount: number; total?: number };
  const issues = (
    result: D1Result,
    check: string,
    detail: (r: Row) => string
  ) =>
    (result.results as Row[]).map((r) => ({
      check,
      reference: r.reference,
      detail: detail(r)
    }));
  return [
    ...issues(
      unbalanced,
      "unbalanced_transaction",
      (r) => `entries sum to ${r.amount} cents`
    ),
    ...issues(
      badTotals,
      "invoice_total_mismatch",
      (r) => `total ${r.total} != lines ${r.amount}`
    ),
    ...issues(
      unposted,
      "invoice_not_posted",
      (r) => `total ${r.total} != receivable ${r.amount}`
    ),
    ...issues(
      unpostedCredits,
      "credit_not_posted",
      (r) => `credit ${r.total} != posted ${r.amount}`
    ),
    ...issues(
      overCredited,
      "over_credited",
      (r) => `credits ${r.amount} > total ${r.total}`
    ),
    ...(await reconcilePayments(db))
  ];
}
