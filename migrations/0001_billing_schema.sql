-- Billing source of truth. Money is stored as integer cents; unit prices are
-- integer micro-dollars (millionths of a dollar) so sub-cent rates are exact.
-- STRICT tables reject values of the wrong type instead of coercing them.

CREATE TABLE plans (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  monthly_fee_cents INTEGER NOT NULL CHECK (monthly_fee_cents >= 0)
) STRICT;

CREATE TABLE meters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL
) STRICT;

-- Graduated pricing: a tier applies from from_quantity up to the next tier's
-- from_quantity. Every plan/meter pair starts with a tier at 0.
CREATE TABLE price_tiers (
  plan_id TEXT NOT NULL REFERENCES plans (id),
  meter_id TEXT NOT NULL REFERENCES meters (id),
  from_quantity INTEGER NOT NULL CHECK (from_quantity >= 0),
  unit_price_micros INTEGER NOT NULL CHECK (unit_price_micros >= 0),
  block_size INTEGER NOT NULL CHECK (block_size > 0),
  PRIMARY KEY (plan_id, meter_id, from_quantity)
) STRICT;

CREATE TABLE customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  plan_id TEXT NOT NULL REFERENCES plans (id),
  created_at TEXT NOT NULL
) STRICT;

-- id is the producer's idempotency key: resending an event is a no-op.
CREATE TABLE usage_events (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  meter_id TEXT NOT NULL REFERENCES meters (id),
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL
) STRICT;

CREATE INDEX usage_events_by_customer_time ON usage_events (customer_id, occurred_at);

-- A draft invoice closes its period to new usage; finalizing it computes the
-- lines and posts to the ledger in one transaction.
CREATE TABLE invoices (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers (id),
  plan_id TEXT NOT NULL REFERENCES plans (id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft', 'finalized')),
  total_cents INTEGER CHECK (total_cents >= 0),
  created_at TEXT NOT NULL,
  finalized_at TEXT,
  UNIQUE (customer_id, period_start),
  CHECK ((status = 'finalized') = (total_cents IS NOT NULL AND finalized_at IS NOT NULL))
) STRICT;

CREATE TABLE invoice_lines (
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  line_no INTEGER NOT NULL CHECK (line_no > 0),
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'usage')),
  meter_id TEXT REFERENCES meters (id),
  description TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity >= 0),
  unit_price_micros INTEGER NOT NULL CHECK (unit_price_micros >= 0),
  block_size INTEGER NOT NULL CHECK (block_size > 0),
  amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
  PRIMARY KEY (invoice_id, line_no),
  CHECK ((kind = 'usage') = (meter_id IS NOT NULL))
) STRICT;

-- Credits reduce what a customer owes on a finalized invoice. id is the
-- caller's idempotency key.
CREATE TABLE credits (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason TEXT NOT NULL,
  approved_by TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX credits_by_invoice ON credits (invoice_id);

-- Double-entry ledger: debits are positive, credits negative, and the entries
-- of each transaction sum to zero. One entry per account per transaction
-- prevents posting the same invoice or credit twice.
CREATE TABLE ledger_entries (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  account TEXT NOT NULL CHECK (
    account IN ('accounts_receivable', 'revenue', 'credits_issued')
  ),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (transaction_id, account)
) STRICT;

CREATE INDEX ledger_entries_by_customer ON ledger_entries (customer_id, account);

-- The ledger is append-only: corrections are new entries, never edits.
-- (Each trigger is on one line so simple statement splitters keep it whole.)
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
