// Local-only billing CLI. Runs the code in src/billing against the same local
// D1 database that `npm run dev` and `wrangler d1 execute --local` use.
// Usage: npm run billing -- <command> [args]   (run with no command for help)
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import { formatCents, parseDollars } from "../src/billing/pricing.ts";
import {
  BillingError,
  finalizeInvoice,
  getInvoice,
  getUsageSummary,
  issueCredit,
  listCustomers,
  listInvoices,
  openInvoice,
  reconcile,
  recordUsage
} from "../src/billing/store.ts";

process.chdir(fileURLToPath(new URL("..", import.meta.url)));

const HELP = `Local billing CLI (uses the local D1 database in .wrangler/state)

Setup
  setup                                  apply migrations and load demo data
  reset                                  delete all local billing data, then setup

Billing
  customers                              list customers and balances
  usage <customer> <YYYY-MM>             usage totals for a month
  record <customer> <meter> <quantity> [--at=ISO-DATE] [--id=EVENT-ID]
                                         record a usage event (default: now, random id)
  invoice <customer> <YYYY-MM>           open and finalize a monthly invoice
  invoices <customer>                    list a customer's invoices
  show <invoice-id>                      invoice lines and credits
  credit <invoice-id> <dollars> <reason...> [--id=CREDIT-ID]
                                         issue an approved credit, e.g. 10.00
  reconcile                              check the ledger against invoices and credits

Meters: workers_requests, ai_neurons. Customers: cus_acme, cus_nimbus, cus_orbit.`;

function wrangler(args, env = {}) {
  const bin = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)
  );
  const result = spawnSync(process.execPath, [bin, ...args], {
    stdio: "inherit",
    env: { ...process.env, ...env }
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function setup() {
  // CI=1 skips wrangler's interactive "apply migrations?" prompt
  wrangler(["d1", "migrations", "apply", "billing", "--local"], { CI: "1" });
  wrangler(["d1", "execute", "billing", "--local", "--file", "seed/demo.sql"]);
}

async function withDatabase(fn) {
  // With no database_id in wrangler.jsonc, local tools key the database by its binding name
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null) } }",
    d1Databases: { DB: "DB" },
    d1Persist: ".wrangler/state/v3/d1"
  });
  try {
    return await fn(await mf.getD1Database("DB"));
  } finally {
    await mf.dispose();
  }
}

async function dropAllTables(db) {
  // Newest first, so tables are dropped before the tables they reference
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'
       ORDER BY rowid DESC`
    )
    .all();
  for (const { name } of results) {
    await db.prepare(`DROP TABLE "${name.replaceAll('"', '""')}"`).run();
  }
  console.log(`Dropped ${results.length} tables.`);
}

function table(rows, columns) {
  const widths = columns.map(([header, get]) =>
    Math.max(header.length, ...rows.map((row) => String(get(row)).length))
  );
  const line = (cells) =>
    cells
      .map((cell, i) => String(cell).padEnd(widths[i]))
      .join("  ")
      .trimEnd();
  console.log(line(columns.map(([header]) => header)));
  for (const row of rows) console.log(line(columns.map(([, get]) => get(row))));
}

const count = (n) => n.toLocaleString("en-US");

function printInvoice(invoice) {
  const total =
    invoice.totalCents === null ? "(draft)" : formatCents(invoice.totalCents);
  console.log(
    `${invoice.id}  ${invoice.status}  ${invoice.periodStart.slice(0, 10)} to ${invoice.periodEnd.slice(0, 10)}  total ${total}`
  );
  table(invoice.lines, [
    ["#", (l) => l.lineNo],
    ["Description", (l) => l.description],
    ["Amount", (l) => formatCents(l.amountCents)]
  ]);
  for (const c of invoice.credits) {
    console.log(
      `Credit ${c.id}: -${formatCents(c.amountCents)} (${c.reason}, approved by ${c.approvedBy})`
    );
  }
}

const commands = {
  async customers(db) {
    table(await listCustomers(db), [
      ["Id", (c) => c.id],
      ["Name", (c) => c.name],
      ["Plan", (c) => c.planName],
      ["Balance", (c) => formatCents(c.balanceCents)]
    ]);
  },
  async usage(db, [customerId, month]) {
    const summary = await getUsageSummary(db, customerId, month);
    table(summary.meters, [
      ["Meter", (m) => m.meterId],
      ["Quantity", (m) => `${count(m.quantity)} ${m.unit}`],
      ["Events", (m) => m.events]
    ]);
  },
  async record(db, [customerId, meterId, quantity], options) {
    const id = options.id ?? `cli:${randomUUID()}`;
    const result = await recordUsage(db, {
      id,
      customerId,
      meterId,
      quantity: Number(quantity),
      occurredAt: options.at ?? new Date().toISOString()
    });
    console.log(`${result.status}: ${id}`);
  },
  async invoice(db, [customerId, month]) {
    const draft = await openInvoice(db, customerId, month);
    const finalized = await finalizeInvoice(db, draft.id);
    printInvoice(await getInvoice(db, finalized.id));
  },
  async invoices(db, [customerId]) {
    table(await listInvoices(db, customerId), [
      ["Id", (i) => i.id],
      ["Status", (i) => i.status],
      [
        "Total",
        (i) => (i.totalCents === null ? "-" : formatCents(i.totalCents))
      ],
      ["Credited", (i) => formatCents(i.creditedCents)]
    ]);
  },
  async show(db, [invoiceId]) {
    printInvoice(await getInvoice(db, invoiceId));
  },
  async credit(db, [invoiceId, dollars, ...reason], options) {
    const { status, credit } = await issueCredit(db, {
      id: options.id ?? `cli:${randomUUID()}`,
      invoiceId,
      amountCents: parseDollars(dollars ?? "") ?? Number.NaN,
      reason: reason.join(" "),
      approvedBy: "local-cli"
    });
    console.log(
      `${status}: ${credit.id} -${formatCents(credit.amountCents)} on ${credit.invoiceId}`
    );
  },
  async reconcile(db) {
    const issues = await reconcile(db);
    if (issues.length === 0)
      console.log("OK: ledger, invoices, and credits reconcile.");
    else
      table(issues, [
        ["Check", (i) => i.check],
        ["Reference", (i) => i.reference],
        ["Detail", (i) => i.detail]
      ]);
    if (issues.length > 0) process.exitCode = 1;
  }
};

const [command, ...rest] = process.argv.slice(2);
const options = Object.fromEntries(
  rest
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [key, ...value] = a.slice(2).split("=");
      return [key, value.join("=")];
    })
);
const args = rest.filter((a) => !a.startsWith("--"));

try {
  if (command === "setup") setup();
  else if (command === "reset") {
    await withDatabase(dropAllTables);
    setup();
  } else if (commands[command]) {
    await withDatabase((db) => commands[command](db, args, options));
  } else {
    console.log(HELP);
    if (command) process.exitCode = 1;
  }
} catch (error) {
  if (error instanceof BillingError) {
    console.error(`Error (${error.code}): ${error.message}`);
  } else if (String(error).includes("no such table")) {
    console.error(
      "The local billing database is not set up. Run: npm run db:setup"
    );
  } else {
    console.error(error);
  }
  process.exitCode = 1;
}
