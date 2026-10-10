/**
 * Rebuilds the hosted demo database from the migrations and seed in one atomic
 * batch. Dropping tables, rather than deleting rows, is the only way past the
 * ledger and payment no-delete triggers, and it leaves the exact seeded state.
 */

/** Splits on semicolons at line ends; the schema keeps triggers on one line. */
export function sqlStatements(script: string): string[] {
  return script
    .split(/;\s*$/m)
    .filter((chunk) => chunk.replace(/^\s*--.*$/gm, "").trim());
}

export async function rebuildDatabase(db: D1Database, scripts: string[]) {
  // Views first, since they depend on tables; triggers and indexes go with
  // their tables. D1's internal tables and migration history are kept.
  const { results } = await db
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE type IN ('view', 'table') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY type = 'table'"
    )
    .all<{ type: "view" | "table"; name: string }>();
  await db.batch([
    // Tables are dropped in any order; references are checked at commit.
    db.prepare("PRAGMA defer_foreign_keys = on"),
    ...results.map(({ type, name }) =>
      db.prepare(`DROP ${type.toUpperCase()} "${name.replaceAll('"', '""')}"`)
    ),
    ...scripts.flatMap(sqlStatements).map((sql) => db.prepare(sql))
  ]);
}
