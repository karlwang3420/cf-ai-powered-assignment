// Shared test setup: a real (in-memory) D1 database in Miniflare, the same
// workerd runtime `npm run dev` uses, with migrations and demo data applied.
import { after } from "node:test";
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

/** One batch per file: a single round trip, applied atomically like a migration. */
export async function applyMigration(db, path) {
  await db.batch(statements(path).map((sql) => db.prepare(sql)));
}

// One workerd per test file, with a pool of separate databases so every test
// still starts from an empty one. Queries go through dispatchFetch into the
// Worker (~3ms) instead of Miniflare's D1 proxy (~45ms per query on Windows).
const POOL = 64;
const worker = `export default {
  async fetch(request, env) {
    const { db, op, statements } = await request.json();
    const DB = env[db];
    const prepare = (s) => DB.prepare(s.sql).bind(...s.params);
    try {
      const result =
        op === "batch"
          ? await DB.batch(statements.map(prepare))
          : await prepare(statements[0])[op]();
      return Response.json({ result: result ?? null });
    } catch (error) {
      return Response.json({ error: String(error?.message ?? error) });
    }
  }
}`;
let mf;
let used = 0;
after(() => mf?.dispose());

function adapter(name) {
  const send = async (op, statements) => {
    const response = await mf.dispatchFetch("http://d1.test/", {
      method: "POST",
      body: JSON.stringify({ db: name, op, statements })
    });
    const { result, error } = await response.json();
    if (error !== undefined) throw new Error(error);
    return result;
  };
  const statement = (sql, params = []) => ({
    sql,
    params,
    bind(...values) {
      // JSON would turn undefined into null; D1 rejects it, so do the same.
      if (values.some((v) => v === undefined))
        throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported");
      return statement(sql, values);
    },
    first: () => send("first", [{ sql, params }]),
    all: () => send("all", [{ sql, params }]),
    run: () => send("run", [{ sql, params }])
  });
  return {
    prepare: (sql) => statement(sql),
    batch: (list) =>
      send(
        "batch",
        list.map(({ sql, params }) => ({ sql, params }))
      )
  };
}

export async function database(t, { seed = true, through = null } = {}) {
  mf ??= new Miniflare({
    modules: true,
    script: worker,
    d1Databases: Object.fromEntries(
      Array.from({ length: POOL }, (_, i) => [`DB${i}`, `test-${i}`])
    )
  });
  if (used >= POOL)
    throw new Error(`more than ${POOL} databases in one test file`);
  const db = adapter(`DB${used++}`);
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
