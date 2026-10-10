-- Four attempts are the automatic campaign, not a lifetime cap: once they are
-- used, an admin may allow one manual attempt at a time. The old CHECKs
-- hard-coded 4, so rebuild the two tables and keep every row.
--
-- Copy the rows aside, drop, recreate under the original names and copy back.
-- Re-inserting under the referenced names clears the deferred foreign-key
-- violations the drops record, so the batch commits with all references intact.
PRAGMA defer_foreign_keys = on;
CREATE TABLE payment_collections_upgrade AS SELECT * FROM payment_collections;
CREATE TABLE payment_attempts_upgrade AS SELECT * FROM payment_attempts;
DROP TABLE payment_attempts;
DROP TABLE payment_collections;

CREATE TABLE payment_collections (
  invoice_id TEXT PRIMARY KEY REFERENCES invoices (id),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  status TEXT NOT NULL CHECK (status IN ('open', 'processing', 'recovering', 'retrying', 'action_required', 'needs_review', 'paid', 'settled', 'past_due')),
  attempts_used INTEGER NOT NULL DEFAULT 0 CHECK (attempts_used >= 0),
  -- 4 automatic attempts, plus one per manual retry
  attempt_limit INTEGER NOT NULL DEFAULT 4 CHECK (attempt_limit >= 4),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  owner_id TEXT,
  owner_active INTEGER NOT NULL DEFAULT 0 CHECK (owner_active IN (0, 1)),
  workflow_id TEXT,
  has_conflict INTEGER NOT NULL DEFAULT 0 CHECK (has_conflict IN (0, 1)),
  updated_at TEXT NOT NULL,
  CHECK (owner_active = 0 OR (owner_id IS NOT NULL AND workflow_id IS NOT NULL)),
  CHECK (attempts_used <= attempt_limit)
) STRICT;
INSERT INTO payment_collections (invoice_id, currency, status, attempts_used, attempt_limit, generation, owner_id, owner_active, workflow_id, has_conflict, updated_at)
SELECT invoice_id, currency, status, attempts_used, 4, generation, owner_id, owner_active, workflow_id, has_conflict, updated_at FROM payment_collections_upgrade;

CREATE TABLE payment_attempts (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES payment_collections (invoice_id),
  attempt_number INTEGER NOT NULL CHECK (attempt_number >= 1),
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
INSERT INTO payment_attempts (id, invoice_id, attempt_number, generation, amount_cents, currency, method_version, idempotency_key, state, decline_type, processor_payment_id, conflicted, outcome_token, created_at, updated_at)
SELECT id, invoice_id, attempt_number, generation, amount_cents, currency, method_version, idempotency_key, state, decline_type, processor_payment_id, conflicted, outcome_token, created_at, updated_at FROM payment_attempts_upgrade;

DROP TABLE payment_attempts_upgrade;
DROP TABLE payment_collections_upgrade;

-- Indexes and triggers went with the dropped tables; recreate them after the
-- copy so the insert triggers do not run again for existing rows.
CREATE INDEX payment_attempts_by_invoice ON payment_attempts (invoice_id, attempt_number);
CREATE UNIQUE INDEX payment_one_unresolved_attempt ON payment_attempts (invoice_id) WHERE state NOT IN ('succeeded', 'declined');
CREATE TRIGGER payment_collection_created AFTER INSERT ON payment_collections BEGIN INSERT INTO payment_timeline (id, invoice_id, generation, kind, message, created_at) VALUES ('collection:' || NEW.invoice_id, NEW.invoice_id, NEW.generation, NEW.status, NEW.status, NEW.updated_at); END;
CREATE TRIGGER payment_collection_status AFTER UPDATE OF status ON payment_collections WHEN NEW.status <> OLD.status BEGIN INSERT INTO payment_timeline (id, invoice_id, generation, attempt_number, kind, message, created_at) VALUES (lower(hex(randomblob(16))), NEW.invoice_id, NEW.generation, NEW.attempts_used, NEW.status, OLD.status || ' → ' || NEW.status, NEW.updated_at); END;
-- Outside a debug reset, the limit only grows by one, after the automatic attempts are used and while no run owns the collection.
CREATE TRIGGER payment_attempt_limit_manual BEFORE UPDATE OF attempt_limit ON payment_collections WHEN NEW.attempt_limit <> OLD.attempt_limit AND NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = OLD.invoice_id) AND (OLD.owner_active = 1 OR OLD.attempts_used < OLD.attempt_limit OR NEW.attempt_limit <> OLD.attempts_used + 1) BEGIN SELECT RAISE(ABORT, 'a manual retry adds exactly one attempt after the automatic attempts are used'); END;
CREATE TRIGGER payment_attempt_payload_immutable BEFORE UPDATE ON payment_attempts WHEN NEW.id <> OLD.id OR NEW.invoice_id <> OLD.invoice_id OR NEW.attempt_number <> OLD.attempt_number OR NEW.generation <> OLD.generation OR NEW.amount_cents <> OLD.amount_cents OR NEW.currency <> OLD.currency OR NEW.method_version <> OLD.method_version OR NEW.idempotency_key <> OLD.idempotency_key OR NEW.created_at <> OLD.created_at OR (OLD.processor_payment_id IS NOT NULL AND NEW.processor_payment_id IS NOT OLD.processor_payment_id) OR (OLD.state IN ('succeeded', 'declined') AND (NEW.state <> OLD.state OR NEW.decline_type IS NOT OLD.decline_type)) BEGIN SELECT RAISE(ABORT, 'payment attempt payload and terminal outcomes are immutable'); END;
CREATE TRIGGER payment_attempt_no_delete BEFORE DELETE ON payment_attempts WHEN NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'payment attempts are immutable'); END;
CREATE TRIGGER payment_attempt_reserved AFTER INSERT ON payment_attempts BEGIN INSERT INTO payment_reservations (attempt_id, invoice_id, amount_cents, status, created_at) VALUES (NEW.id, NEW.invoice_id, NEW.amount_cents, 'reserved', NEW.created_at); UPDATE payment_collections SET attempts_used = NEW.attempt_number, status = 'processing', updated_at = NEW.created_at WHERE invoice_id = NEW.invoice_id; INSERT INTO payment_timeline (id, invoice_id, generation, attempt_number, kind, message, created_at) VALUES ('prepared:' || NEW.id, NEW.invoice_id, NEW.generation, NEW.attempt_number, 'attempt_prepared', NEW.idempotency_key, NEW.created_at); END;
