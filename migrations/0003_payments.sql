-- Rebuild rather than changing applied migrations. Preserve IDs and all postings.
CREATE TABLE ledger_entries_payment_upgrade (
  id INTEGER PRIMARY KEY,
  transaction_id TEXT NOT NULL,
  account TEXT NOT NULL CHECK (account IN ('accounts_receivable', 'revenue', 'credits_issued', 'cash')),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents <> 0),
  description TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (transaction_id, account)
) STRICT;
INSERT INTO ledger_entries_payment_upgrade SELECT * FROM ledger_entries;
DROP TABLE ledger_entries;
ALTER TABLE ledger_entries_payment_upgrade RENAME TO ledger_entries;
CREATE INDEX ledger_entries_by_customer ON ledger_entries (customer_id, account);
CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

CREATE TABLE payment_methods (
  customer_id TEXT PRIMARY KEY REFERENCES customers (id),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0)
) STRICT;
INSERT INTO payment_methods (customer_id) SELECT id FROM customers;
CREATE TRIGGER customers_payment_method AFTER INSERT ON customers BEGIN INSERT INTO payment_methods (customer_id) VALUES (NEW.id); END;
CREATE TRIGGER payment_methods_monotonic BEFORE UPDATE ON payment_methods WHEN NEW.customer_id <> OLD.customer_id OR NEW.version <> OLD.version + 1 BEGIN SELECT RAISE(ABORT, 'payment method version must advance once'); END;

CREATE TABLE payment_collections (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices (id),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status IN ('open', 'processing', 'recovering', 'retrying', 'action_required', 'needs_review', 'paid', 'settled', 'past_due')),
  attempts_used INTEGER NOT NULL DEFAULT 0 CHECK (attempts_used BETWEEN 0 AND 4),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  owner_id TEXT,
  owner_active INTEGER NOT NULL DEFAULT 0 CHECK (owner_active IN (0, 1)),
  workflow_id TEXT,
  has_conflict INTEGER NOT NULL DEFAULT 0 CHECK (has_conflict IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (owner_active = 0 OR (owner_id IS NOT NULL AND workflow_id IS NOT NULL))
) STRICT;

CREATE TABLE payment_timeline (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES payment_collections (invoice_id),
  generation INTEGER NOT NULL,
  attempt_number INTEGER,
  kind TEXT NOT NULL,
  message TEXT NOT NULL,
  deadline_at TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX payment_timeline_by_invoice ON payment_timeline (invoice_id, created_at, id);
CREATE UNIQUE INDEX payment_notice_once ON payment_timeline (invoice_id, attempt_number, kind) WHERE kind IN ('retry_scheduled', 'card_update_requested');
CREATE TRIGGER payment_timeline_no_update BEFORE UPDATE ON payment_timeline BEGIN SELECT RAISE(ABORT, 'payment timeline is immutable'); END;
CREATE TRIGGER payment_timeline_no_delete BEFORE DELETE ON payment_timeline BEGIN SELECT RAISE(ABORT, 'payment timeline is immutable'); END;
CREATE TRIGGER payment_collection_created AFTER INSERT ON payment_collections BEGIN INSERT INTO payment_timeline (id, invoice_id, generation, kind, message, created_at) VALUES ('collection:' || NEW.invoice_id, NEW.invoice_id, NEW.generation, NEW.status, NEW.status, NEW.updated_at); END;
CREATE TRIGGER payment_collection_status AFTER UPDATE OF status ON payment_collections WHEN NEW.status <> OLD.status BEGIN INSERT INTO payment_timeline (id, invoice_id, generation, attempt_number, kind, message, created_at) VALUES (lower(hex(randomblob(16))), NEW.invoice_id, NEW.generation, NEW.attempts_used, NEW.status, OLD.status || ' → ' || NEW.status, NEW.updated_at); END;
INSERT INTO payment_collections (invoice_id, status, updated_at) SELECT i.id, CASE WHEN i.total_cents - COALESCE((SELECT SUM(amount_cents) FROM credits WHERE invoice_id = i.id), 0) = 0 THEN 'settled' ELSE 'open' END, i.finalized_at FROM invoices i WHERE i.status = 'finalized';
CREATE TRIGGER invoice_payment_collection AFTER UPDATE OF status ON invoices WHEN NEW.status = 'finalized' AND OLD.status = 'draft' BEGIN INSERT INTO payment_collections (invoice_id, status, updated_at) VALUES (NEW.id, CASE WHEN NEW.total_cents = 0 THEN 'settled' ELSE 'open' END, NEW.finalized_at); END;

-- Payload is immutable; outcome and processor identity are separate mutable facts.
CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES payment_collections (invoice_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number BETWEEN 1 AND 4),
  generation INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  method_version INTEGER NOT NULL CHECK (method_version > 0),
  idempotency_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL DEFAULT 'prepared' CHECK (state IN ('prepared', 'pending', 'recovering', 'needs_review', 'succeeded', 'declined')),
  decline_type TEXT CHECK (decline_type IN ('soft', 'hard')),
  processor_payment_id TEXT UNIQUE,
  conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1)),
  outcome_token TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (invoice_id, attempt_number),
  CHECK ((state = 'declined') = (decline_type IS NOT NULL))
) STRICT;
CREATE INDEX payment_attempts_by_invoice ON payment_attempts (invoice_id, attempt_number);
CREATE UNIQUE INDEX payment_one_unresolved_attempt ON payment_attempts (invoice_id) WHERE state NOT IN ('succeeded', 'declined');
CREATE TRIGGER payment_attempt_payload_immutable BEFORE UPDATE ON payment_attempts WHEN NEW.id <> OLD.id OR NEW.invoice_id <> OLD.invoice_id OR NEW.attempt_number <> OLD.attempt_number OR NEW.generation <> OLD.generation OR NEW.amount_cents <> OLD.amount_cents OR NEW.currency <> OLD.currency OR NEW.method_version <> OLD.method_version OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at OR (OLD.processor_payment_id IS NOT NULL AND NEW.processor_payment_id IS NOT OLD.processor_payment_id) OR (OLD.state IN ('succeeded', 'declined') AND (NEW.state <> OLD.state OR NEW.decline_type IS NOT OLD.decline_type)) BEGIN SELECT RAISE(ABORT, 'payment attempt payload and terminal outcomes are immutable'); END;
CREATE TRIGGER payment_attempt_no_delete BEFORE DELETE ON payment_attempts BEGIN SELECT RAISE(ABORT, 'payment attempts are immutable'); END;

CREATE TABLE payment_reservations (
  attempt_id TEXT PRIMARY KEY REFERENCES payment_attempts (id),
  invoice_id TEXT NOT NULL REFERENCES payment_collections (invoice_id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  status TEXT NOT NULL CHECK (status IN ('reserved', 'converted', 'released')),
  created_at TEXT NOT NULL,
  resolved_at TEXT
) STRICT;
CREATE INDEX payment_reservations_by_invoice ON payment_reservations (invoice_id, status);
CREATE TRIGGER payment_reservation_immutable BEFORE UPDATE ON payment_reservations WHEN NEW.attempt_id <> OLD.attempt_id OR NEW.invoice_id <> OLD.invoice_id OR NEW.amount_cents <> OLD.amount_cents OR NEW.created_at <> OLD.created_at OR OLD.status <> 'reserved' BEGIN SELECT RAISE(ABORT, 'payment reservation is immutable after resolution'); END;
CREATE TRIGGER payment_reservation_no_delete BEFORE DELETE ON payment_reservations BEGIN SELECT RAISE(ABORT, 'payment reservations are immutable'); END;
CREATE TRIGGER payment_attempt_reserved AFTER INSERT ON payment_attempts BEGIN INSERT INTO payment_reservations (attempt_id, invoice_id, amount_cents, status, created_at) VALUES (NEW.id, NEW.invoice_id, NEW.amount_cents, 'reserved', NEW.created_at); UPDATE payment_collections SET attempts_used = NEW.attempt_number, status = 'processing', updated_at = NEW.created_at WHERE invoice_id = NEW.invoice_id; INSERT INTO payment_timeline (id, invoice_id, generation, attempt_number, kind, message, created_at) VALUES ('prepared:' || NEW.id, NEW.invoice_id, NEW.generation, NEW.attempt_number, 'attempt_prepared', NEW.idempotency_key, NEW.created_at); END;

CREATE TABLE payments (
  processor_payment_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE REFERENCES payment_attempts (id),
  invoice_id TEXT NOT NULL REFERENCES invoices (id),
  customer_id TEXT NOT NULL REFERENCES customers (id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX payments_by_invoice ON payments (invoice_id);
CREATE TRIGGER payments_no_update BEFORE UPDATE ON payments BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;

-- Signature verification is the transport's responsibility, before durable receipt.
CREATE TABLE payment_webhook_inbox (
  event_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  received_at TEXT NOT NULL,
  applied_at TEXT,
  application_result TEXT CHECK (application_result IN ('applied', 'conflict')),
  notified_at TEXT
) STRICT;
CREATE INDEX payment_webhook_unapplied ON payment_webhook_inbox (received_at) WHERE applied_at IS NULL;
CREATE TRIGGER payment_inbox_payload_immutable BEFORE UPDATE ON payment_webhook_inbox WHEN NEW.event_id <> OLD.event_id OR NEW.payload <> OLD.payload OR NEW.received_at <> OLD.received_at OR (OLD.applied_at IS NOT NULL AND (NEW.applied_at IS NOT OLD.applied_at OR NEW.application_result IS NOT OLD.application_result)) BEGIN SELECT RAISE(ABORT, 'webhook payload and application are immutable'); END;
CREATE TRIGGER payment_inbox_no_delete BEFORE DELETE ON payment_webhook_inbox BEGIN SELECT RAISE(ABORT, 'webhook inbox is immutable'); END;

-- A credit can settle even past_due; never clear a contradictory terminal result.
CREATE TRIGGER credit_settles_collection AFTER INSERT ON credits BEGIN UPDATE payment_collections SET status = CASE WHEN status = 'paid' THEN 'paid' ELSE 'settled' END, updated_at = NEW.created_at WHERE invoice_id = NEW.invoice_id AND has_conflict = 0 AND NOT EXISTS (SELECT 1 FROM payment_reservations WHERE invoice_id = NEW.invoice_id AND status = 'reserved') AND (SELECT total_cents FROM invoices WHERE id = NEW.invoice_id) - (SELECT COALESCE(SUM(amount_cents), 0) FROM credits WHERE invoice_id = NEW.invoice_id) - (SELECT COALESCE(SUM(amount_cents), 0) FROM payments WHERE invoice_id = NEW.invoice_id) = 0; END;

CREATE VIEW payment_balances AS
SELECT i.id AS invoice_id, i.customer_id, i.total_cents,
  COALESCE((SELECT SUM(amount_cents) FROM credits WHERE invoice_id = i.id), 0) AS credited_cents,
  COALESCE((SELECT SUM(amount_cents) FROM payments WHERE invoice_id = i.id), 0) AS paid_cents,
  COALESCE((SELECT SUM(amount_cents) FROM payment_reservations WHERE invoice_id = i.id AND status = 'reserved'), 0) AS reserved_cents
FROM invoices i WHERE i.status = 'finalized';
