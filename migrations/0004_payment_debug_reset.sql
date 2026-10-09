-- Local debug reset only. Payment history stays immutable unless one invoice is
-- unlocked inside the same atomic batch that clears it (see debugResetPayment).
CREATE TABLE payment_debug_unlock (
  invoice_id TEXT PRIMARY KEY REFERENCES payment_collections (invoice_id)
) STRICT;

DROP TRIGGER ledger_entries_no_delete;
CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries WHEN NOT EXISTS (SELECT 1 FROM payments p JOIN payment_debug_unlock u ON u.invoice_id = p.invoice_id WHERE OLD.transaction_id = 'payment:' || p.processor_payment_id AND OLD.account IN ('cash', 'accounts_receivable')) BEGIN SELECT RAISE(ABORT, 'ledger entries are immutable'); END;

DROP TRIGGER payments_no_delete;
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments WHEN NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'payments are immutable'); END;

DROP TRIGGER payment_reservation_no_delete;
CREATE TRIGGER payment_reservation_no_delete BEFORE DELETE ON payment_reservations WHEN NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'payment reservations are immutable'); END;

DROP TRIGGER payment_attempt_no_delete;
CREATE TRIGGER payment_attempt_no_delete BEFORE DELETE ON payment_attempts WHEN NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'payment attempts are immutable'); END;

DROP TRIGGER payment_inbox_no_delete;
CREATE TRIGGER payment_inbox_no_delete BEFORE DELETE ON payment_webhook_inbox WHEN NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = json_extract(OLD.payload, '$.invoiceId')) BEGIN SELECT RAISE(ABORT, 'webhook inbox is immutable'); END;

DROP TRIGGER payment_timeline_no_delete;
CREATE TRIGGER payment_timeline_no_delete BEFORE DELETE ON payment_timeline WHEN NOT EXISTS (SELECT 1 FROM payment_debug_unlock WHERE invoice_id = OLD.invoice_id) BEGIN SELECT RAISE(ABORT, 'payment timeline is immutable'); END;
