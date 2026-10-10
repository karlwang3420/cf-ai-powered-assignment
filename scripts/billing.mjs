// Local-only billing CLI. Runs the code in src/billing against the same local
// D1 database that `npm run dev` and `wrangler d1 execute --local` use.
// Usage: npm run billing -- <command> [args]   (run with no command for help)
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
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
  setup                                  apply migrations; seed only an empty database
  reset-demo                             reseed everything (billing, mock processor, chats)
                                         through the running dev server; no restart needed
  reset                                  DESTRUCTIVE: delete local merchant billing data only

Options: --persist-to=PATH selects isolated persistence (default .wrangler/state).
Payment commands and reset-demo use the running local API, not direct D1
(--url=http://localhost:5173).

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
  reconcile                              check internal ledger/payment/reservation invariants

Payments (running npm run dev required; no AI calls)
  payments [customer]                    list authoritative collection status
  payment <invoice-id>                   inspect amounts, attempts and timeline
  payment-timeline <invoice-id>           inspect durable notices and correlation IDs
  payment-processor <invoice-id>          inspect processor records and delivery outbox
  collect <invoice-id>                    start/recover bounded collection (may charge)
  retry <invoice-id>                      after the 4 automatic attempts, one manual attempt (may charge)
  reconcile-payments [invoice-id] [--resume]
                                         drain inbox and compare original keys; resume is opt-in

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

async function setup() {
  // Apply upgrades without deleting/reseeding existing merchant data.
  const local = ["--local", "--persist-to", persistence];
  wrangler(["d1", "migrations", "apply", "billing", ...local], { CI: "1" });
  const { count } = await withDatabase((db) =>
    db.prepare("SELECT COUNT(*) AS count FROM customers").first()
  );
  if (count === 0) {
    wrangler(["d1", "execute", "billing", ...local, "--file", "seed/demo.sql"]);
  } else {
    console.log(
      "Migrations applied; existing customers/data preserved (no demo reseed)."
    );
  }
}

async function withDatabase(fn) {
  // With no database_id in wrangler.jsonc, local tools key the database by its binding name
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response(null) } }",
    d1Databases: { DB: "DB" },
    d1Persist: path.join(persistence, "v3", "d1")
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
      console.log(
        "OK: internal ledger, invoices, credits, payments and reservations reconcile (processor not queried)."
      );
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

const persistence = path.resolve(options["persist-to"] || ".wrangler/state");
const paymentCommands = new Set([
  "payments",
  "payment",
  "payment-timeline",
  "payment-processor",
  "collect",
  "retry",
  "reconcile-payments",
  "reset-demo"
]);
async function paymentCommand() {
  const base = new URL(options.url || "http://localhost:5173");
  if (
    base.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
  )
    throw new Error(
      "Payment CLI requires an http loopback --url for the local demo API."
    );
  let route = "/api/payments",
    method = "GET",
    body;
  if (command === "reset-demo") {
    route = "/api/demo/reset";
    method = "POST";
  } else if (command === "reconcile-payments") {
    route += "/reconcile";
    method = "POST";
    body = {
      ...(args[0] ? { invoiceId: args[0] } : {}),
      resume: "resume" in options
    };
  } else if (command === "payments") {
    if (args[0]) route += `?customerId=${encodeURIComponent(args[0])}`;
  } else {
    if (!args[0]) throw new Error(`${command} requires an invoice ID`);
    route += `/${encodeURIComponent(args[0])}`;
    if (command === "payment-timeline") route += "/timeline";
    if (command === "payment-processor") route += "/processor";
    const post = { collect: "/collect", retry: "/retry" };
    if (post[command]) {
      route += post[command];
      method = "POST";
    }
  }
  const response = await fetch(new URL(route, base), {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const result = await response.json();
  console.log(JSON.stringify(result, null, 2));
  if (
    !response.ok ||
    (command === "reconcile-payments" &&
      (result.issues?.length ||
        result.inbox?.some((e) => !e.applied) ||
        result.checks?.some((c) =>
          ["unresolved", "error", "conflict"].includes(c.result)
        )))
  )
    process.exitCode = 1;
}

try {
  if (command === "setup") await setup();
  else if (paymentCommands.has(command)) await paymentCommand();
  else if (command === "reset") {
    await withDatabase(dropAllTables);
    await setup();
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
