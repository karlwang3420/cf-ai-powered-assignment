// Schema and seed bundled into the Worker for the hosted demo reset. Keep this
// list in step with migrations/ (tests/demo.test.mjs checks it).
import billingSchema from "../../migrations/0001_billing_schema.sql?raw";
import priceCatalog from "../../migrations/0002_price_catalog.sql?raw";
import payments from "../../migrations/0003_payments.sql?raw";
import paymentDebugReset from "../../migrations/0004_payment_debug_reset.sql?raw";
import demoSeed from "../../seed/demo.sql?raw";

export const DEMO_SQL = [
  billingSchema,
  priceCatalog,
  payments,
  paymentDebugReset,
  demoSeed
];
