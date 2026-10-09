// Shared test setup: a real (in-memory) D1 database in Miniflare, the same
// workerd runtime `npm run dev` uses, with migrations and demo data applied.
import { readdirSync, readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import {
  BillingError,
  finalizeInvoice,
  openInvoice
} from "../../src/billing/store.ts";

export const NOW = new Date("2026-10-07T12:00:00.000Z");
const root = new URL("../../", import.meta.url);

/** Splits on semicolons at line ends; the schema keeps triggers on one line. */
function statements(path) {
  return readFileSync(new URL(path, root), "utf8")
    .split(/;\s*$/m)
    .filter((chunk) => chunk.replace(/^\s*--.*$/gm, "").trim());
}

export async function applyMigration(db, path) {
  for (const sql of statements(path)) await db.prepare(sql).run();
}

export async function database(t, { seed = true, through = null } = {}) {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null) } }",
    d1Databases: { DB: "billing-test" }
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  const files = readdirSync(new URL("migrations/", root))
    .sort()
    .filter((name) => through === null || name <= through)
    .map((name) => `migrations/${name}`);
  if (seed) files.push("seed/demo.sql");
  for (const file of files) {
    await applyMigration(db, file);
  }
  return db;
}

export async function invoice(db, customerId, month) {
  const draft = await openInvoice(db, customerId, month, NOW);
  return finalizeInvoice(db, draft.id, NOW);
}

/** assert.rejects predicate for a BillingError with the given code */
export const code = (expected) => (error) =>
  error instanceof BillingError && error.code === expected;
