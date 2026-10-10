// Schema and seed bundled into the Worker for the demo reset. Keep this list
// in step with migrations/ (tests/demo.test.mjs checks it).
import billingSchema from "../../migrations/0001_billing_schema.sql?raw";
import priceCatalog from "../../migrations/0002_price_catalog.sql?raw";
import payments from "../../migrations/0003_payments.sql?raw";
import paymentDebugReset from "../../migrations/0004_payment_debug_reset.sql?raw";
import manualRetry from "../../migrations/0005_manual_retry.sql?raw";
import lateSuccess from "../../migrations/0006_late_success.sql?raw";
import demoSeed from "../../seed/demo.sql?raw";

/** Every migration by file name, in order, so a rebuild can record them as applied. */
export const DEMO_MIGRATIONS: [name: string, sql: string][] = [
  ["0001_billing_schema.sql", billingSchema],
  ["0002_price_catalog.sql", priceCatalog],
  ["0003_payments.sql", payments],
  ["0004_payment_debug_reset.sql", paymentDebugReset],
  ["0005_manual_retry.sql", manualRetry],
  ["0006_late_success.sql", lateSuccess]
];

export const DEMO_SQL = [...DEMO_MIGRATIONS.map(([, sql]) => sql), demoSeed];
