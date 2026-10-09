// Real repository Vite configuration, two Workers, real Workflow sleeps/events and fresh persistence.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { createServer } from "vite";
import { Miniflare as StoreMiniflare } from "miniflare";
import { applyMigration, invoice } from "./helpers/d1.mjs";
import { checkPaymentLayout } from "./helpers/payment-layout.mjs";
import {
  claimCollection,
  preparePaymentAttempt
} from "../src/billing/payments.ts";
import { chargePayload } from "../src/payments/service.ts";
import {
  DEMO_PROCESSOR_TOKEN,
  DEMO_WEBHOOK_SECRET
} from "../src/payments/protocol.ts";

const exec = promisify(execFile);
const requirePlugin = createRequire(
  import.meta.resolve("@cloudflare/vite-plugin")
);
const { Miniflare } = requirePlugin("miniflare");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(read, accepts, timeout = 60_000) {
  const end = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accepts(value)) return value;
    await sleep(200);
  } while (Date.now() < end);
  assert.fail(`Integration condition timed out: ${JSON.stringify(value)}`);
}
async function files(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await files(name)));
    else found.push(name);
  }
  return found;
}

// Fixture-only delay of a real pending charge. No production force-outcome endpoint,
// immutable payload changes or fake webhook. payment-test mode runs demo waits at
// PAYMENT_TIME_SCALE 0.2 (6s pending checks, 6s card wait, 0.6/1.2/1.8s dunning).
async function seedLateProcessor(directory, attempt) {
  const script = (
    await build({
      entryPoints: ["processor/worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      external: ["cloudflare:workers"],
      logLevel: "silent"
    })
  ).outputFiles[0].text;
  const mf = new Miniflare({
    resourcePersistencePath: path.join(directory, "v3"),
    workers: [
      {
        name: "mock-payment-processor",
        modules: true,
        script,
        compatibilityDate: "2026-06-11",
        bindings: {
          PROCESSOR_TOKEN: DEMO_PROCESSOR_TOKEN,
          PROCESSOR_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET
        },
        durableObjects: {
          PROCESSOR_STATE: { className: "ProcessorState", useSQLite: true }
        }
      }
    ]
  });
  try {
    const call = (route, body, method = "POST") =>
      mf.dispatchFetch(`https://processor.test${route}`, {
        method,
        headers: {
          authorization: `Bearer ${DEMO_PROCESSOR_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify(body)
      });
    assert.equal(
      (
        await call(
          "/demo/scenarios",
          { invoiceId: attempt.invoiceId, scenarios: ["pending"] },
          "PUT"
        )
      ).status,
      200
    );
    const result = await (
      await call("/charges", chargePayload(attempt))
    ).json();
    assert.equal(result.charge.status, "pending");
  } finally {
    await mf.dispose();
  }
  const sqlite = (await files(directory))
    .filter((f) => f.endsWith(".sqlite") && f.includes("ProcessorState"))
    .filter((f) => {
      const candidate = new DatabaseSync(f, { readOnly: true });
      try {
        return Boolean(
          candidate
            .prepare(
              "SELECT name FROM sqlite_master WHERE name = 'processor_keys'"
            )
            .get()
        );
      } finally {
        candidate.close();
      }
    });
  assert.equal(sqlite.length, 1);
  const db = new DatabaseSync(sqlite[0]);
  try {
    assert.equal(
      db
        .prepare(
          "UPDATE processor_keys SET resolve_at = ? WHERE idempotency_key = ? AND scenario = 'pending'"
        )
        // Resolve after Vite boot plus three scaled 6s checks reach needs_review.
        .run(Date.now() + 60_000, attempt.idempotencyKey).changes,
      1
    );
  } finally {
    db.close();
  }
}

test(
  "isolated two-Worker payment matrix, CLI, late signed callback and local observability",
  { timeout: 240_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "payment-integration-")
    );
    let server, seed;
    const previous = process.env.PAYMENT_TEST_PERSIST;
    process.env.PAYMENT_TEST_PERSIST = directory;
    t.after(async () => {
      await server?.close();
      await seed?.dispose();
      if (previous === undefined) delete process.env.PAYMENT_TEST_PERSIST;
      else process.env.PAYMENT_TEST_PERSIST = previous;
      await rm(directory, { recursive: true, force: true });
    });
    seed = new StoreMiniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null) } }",
      d1Databases: { DB: "DB" },
      d1Persist: path.join(directory, "v3", "d1")
    });
    const db = await seed.getD1Database("DB");
    for (const file of (await readdir("migrations")).sort())
      await applyMigration(db, `migrations/${file}`);
    await applyMigration(db, "seed/demo.sql");
    const names = [
      "success",
      "soft",
      "hard",
      "exhausted",
      "lost_response",
      "lost_webhook",
      "duplicate_webhook",
      "pending",
      "late",
      "credit"
    ];
    const invoices = {};
    for (const name of names) {
      // Separate customer method versions prevent one scenario waking another scenario's card wait.
      await db
        .prepare(
          "INSERT INTO customers (id,name,email,plan_id,created_at) VALUES (?,?,?,'standard','2026-07-01T00:00:00Z')"
        )
        .bind(`test_${name}`, name, `${name}@example.test`)
        .run();
      invoices[name] = await invoice(db, `test_${name}`, "2026-09");
    }
    const owner = await claimCollection(db, invoices.late.id, 0);
    const prepared = await preparePaymentAttempt(db, owner);
    assert.equal(prepared.kind, "attempt");
    await seed.dispose();
    seed = undefined;
    await seedLateProcessor(directory, prepared.attempt);
    server = await createServer({
      configFile: path.resolve("vite.config.ts"),
      mode: "payment-test",
      server: { host: "127.0.0.1", port: 0 },
      clearScreen: false,
      plugins: [
        {
          name: "isolated-approved-credit-fixture",
          enforce: "pre",
          transform(code, id) {
            if (!id.replaceAll("\\", "/").endsWith("/src/server.ts")) return;
            const seam = "async fetch(request: Request, env: Env) {";
            assert.ok(code.includes(seam));
            return (
              `import { issueCredit as fixtureCredit } from './billing/store.ts';\n` +
              code.replace(
                seam,
                `${seam}
          if (new URL(request.url).pathname === '/api/__test-approved-credit') {
            return Response.json(await fixtureCredit(env.DB, {
              id: 'integration-full-credit', invoiceId: '${invoices.credit.id}', amountCents: 500,
              reason: 'Isolated approved full credit during card wait', approvedBy: 'integration-operator'
            }));
          }`
              )
            );
          }
        }
      ]
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    console.log(`ISOLATED_PAYMENT_ORIGIN=${origin}`);
    const call = async (route, method = "GET", body) => {
      const response = await fetch(`${origin}/api${route}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      assert.ok(response.ok, `${response.status} ${route}: ${text}`);
      return JSON.parse(text);
    };
    const route = (name, suffix = "") =>
      `/payments/${invoices[name].id}${suffix}`;
    const read = (name) => call(route(name));
    const complete = (name) =>
      eventually(
        () => call(route(name, "/run")),
        (r) => r.status === "complete",
        150_000
      );
    const cli = (...args) =>
      exec(
        process.execPath,
        [
          "scripts/billing.mjs",
          ...args,
          `--url=${origin}`,
          `--persist-to=${directory}`
        ],
        { timeout: 40_000 }
      );
    const scenarios = {
      success: ["success"],
      soft: ["soft_decline", "success"],
      hard: ["hard_decline", "success"],
      exhausted: [
        "soft_decline",
        "soft_decline",
        "soft_decline",
        "soft_decline"
      ],
      lost_response: ["lost_response"],
      lost_webhook: ["lost_webhook"],
      duplicate_webhook: ["duplicate_webhook"],
      pending: ["pending"],
      credit: ["hard_decline"]
    };
    for (const [name, queue] of Object.entries(scenarios))
      await call(route(name, "/scenarios"), "PUT", { scenarios: queue });
    for (const name of names) await call(route(name, "/collect"), "POST");
    await Promise.all([
      (async () => {
        const hard = await eventually(
          () => read("hard"),
          (p) => p.status === "action_required"
        );
        await call("/payments/method", "POST", {
          customerId: hard.customerId,
          expectedVersion: hard.methodVersion
        });
      })(),
      (async () => {
        const credit = await eventually(
          () => read("credit"),
          (p) =>
            p.status === "action_required" &&
            p.timeline.some((e) => e.kind === "card_update_requested")
        );
        // Test-only fetch transform calls unchanged issueCredit against the actual live bound D1.
        // Explorer's SQL "batch" loops statements non-atomically, so it cannot substitute for db.batch.
        const result = await call("/__test-approved-credit", "POST");
        assert.equal(result.status, "issued");
        assert.equal(result.credit.invoiceId, credit.invoiceId);
      })()
    ]);
    for (const name of names.filter((n) => n !== "late")) await complete(name);
    for (const name of [
      "success",
      "soft",
      "hard",
      "lost_response",
      "lost_webhook",
      "duplicate_webhook",
      "pending"
    ]) {
      const payment = await read(name);
      assert.equal(payment.status, "paid", name);
      assert.equal(payment.paidCents, invoices[name].totalCents, name);
      assert.equal(payment.reservedCents, 0, name);
      assert.equal(
        payment.attemptsUsed,
        ["soft", "hard"].includes(name) ? 2 : 1,
        name
      );
      const processor = await call(route(name, "/processor"));
      assert.equal(processor.requests.length, payment.attemptsUsed, name);
      assert.equal(
        processor.requests.filter((r) => r.charge.status === "succeeded")
          .length,
        1,
        name
      );
      const reconciliation = await call("/payments/reconcile", "POST", {
        invoiceId: payment.invoiceId
      });
      assert.deepEqual(reconciliation.issues, []);
      assert.ok(
        reconciliation.checks.every((c) =>
          ["applied", "duplicate"].includes(c.result)
        )
      );
    }
    const hard = await read("hard");
    assert.ok(hard.attempts[1].methodVersion > hard.attempts[0].methodVersion);
    const exhausted = await read("exhausted");
    assert.equal(exhausted.status, "past_due");
    assert.equal(exhausted.attemptsUsed, 4);
    assert.equal(exhausted.reservedCents, 0);
    await call("/payments/reconcile", "POST", {
      invoiceId: exhausted.invoiceId,
      resume: true
    });
    await complete("exhausted");
    assert.equal(
      (await call(route("exhausted", "/processor"))).requests.length,
      4
    );
    const credited = await read("credit");
    assert.equal(credited.status, "settled");
    assert.equal(credited.creditedCents, 500);
    assert.equal(credited.paidCents, 0);
    assert.equal(credited.attemptsUsed, 1);
    assert.equal(
      (await call(route("lost_webhook", "/processor"))).outbox[0].state,
      "dropped"
    );
    const duplicate = await eventually(
      () => call(route("duplicate_webhook", "/processor")),
      (p) => p.outbox[0].state === "delivered"
    );
    assert.equal(duplicate.outbox[0].attempts, 2);
    const pending = await eventually(
      () => call(route("pending", "/processor")),
      (p) =>
        p.outbox.length === 2 && p.outbox.every((e) => e.state === "delivered")
    );
    assert.equal(pending.requests.length, 1);

    const review = await eventually(
      async () => {
        const run = await call(route("late", "/run"));
        assert.notEqual(run.status, "errored", JSON.stringify(run));
        return read("late");
      },
      (p) => p.status === "needs_review" && !p.ownerActive,
      110_000
    );
    assert.equal(review.reservedCents, 500);
    assert.equal(review.attemptsUsed, 1);
    assert.equal((await complete("late")).output.status, "needs_review");
    const beforeLate = await call("/payments/reconcile", "POST", {
      invoiceId: review.invoiceId
    });
    assert.equal(beforeLate.checks[0].result, "unresolved");
    await assert.rejects(
      cli("reconcile-payments", review.invoiceId),
      (error) => error.code === 1 && error.stdout.includes('"unresolved"')
    );
    assert.equal((await read("late")).creditableCents, 0);
    const late = await eventually(
      () => read("late"),
      (p) => p.status === "paid",
      90_000
    );
    assert.equal(late.workflowId, review.workflowId);
    assert.equal(late.ownerActive, 0);
    assert.equal(late.attemptsUsed, 1);
    assert.equal(late.reservedCents, 0);
    const lateProcessor = await eventually(
      () => call(route("late", "/processor")),
      (p) =>
        p.outbox.some(
          (e) =>
            e.event.charge.status === "succeeded" && e.state === "delivered"
        )
    );
    assert.equal(lateProcessor.requests.length, 1);
    assert.equal(
      (await call(route("late", "/run"))).output.status,
      "needs_review",
      "late money does not rewrite old Workflow output"
    );
    assert.equal(
      JSON.parse((await cli("payment", late.invoiceId)).stdout).status,
      "paid"
    );
    assert.deepEqual(
      JSON.parse((await cli("reconcile-payments", late.invoiceId)).stdout)
        .issues,
      []
    );

    const explorer = await fetch(`${origin}/cdn-cgi/local/explorer`);
    assert.match(
      await explorer.text(),
      /<title>Cloudflare Local Explorer<\/title>/
    );
    // Read-only local observability query, independently proving actual logs/spans rather than just a page shell.
    const telemetry = async (sql) => {
      const response = await fetch(
        `${origin}/cdn-cgi/local/explorer/api/local/observability/query`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql })
        }
      );
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    };
    const logs = await telemetry(
      "SELECT message, trace_id FROM logs WHERE message LIKE '%payment_collection_finished%' LIMIT 3"
    );
    console.log("LOCAL_OBSERVABILITY_LOGS", JSON.stringify(logs));
    assert.equal(logs.success, true);
    assert.ok(logs.result.rows.length > 0);
    assert.match(logs.result.rows[0][0], /invoiceId.*workflowInstanceId/);
    assert.ok(logs.result.rows[0][1]);
    const spans = await telemetry(
      "SELECT service, COUNT(*) AS count FROM spans GROUP BY service"
    );
    console.log("LOCAL_OBSERVABILITY_SPANS", JSON.stringify(spans));
    assert.equal(spans.success, true);
    for (const worker of ["billing-assistant", "mock-payment-processor"])
      assert.ok(
        spans.result.rows.some(
          ([service, count]) => service === worker && count > 0
        )
      );
    await checkPaymentLayout(origin);
    // Optional bounded pause solely for browse CLI smoke against this same isolated live app.
    if (process.env.PAYMENT_BROWSER_HOLD_MS)
      await sleep(
        Math.min(180_000, Number(process.env.PAYMENT_BROWSER_HOLD_MS))
      );
    await server.close();
    server = undefined;
    seed = new StoreMiniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null) } }",
      d1Databases: { DB: "DB" },
      d1Persist: path.join(directory, "v3", "d1")
    });
    const finalDb = await seed.getD1Database("DB");
    for (const name of [
      "success",
      "soft",
      "hard",
      "lost_response",
      "lost_webhook",
      "duplicate_webhook",
      "pending",
      "late"
    ]) {
      assert.equal(
        (
          await finalDb
            .prepare(
              "SELECT COUNT(*) AS count FROM payments WHERE invoice_id = ?"
            )
            .bind(invoices[name].id)
            .first()
        ).count,
        1,
        name
      );
    }
    assert.deepEqual(
      (
        await finalDb
          .prepare(
            "SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_cents) != 0"
          )
          .all()
      ).results,
      []
    );
    console.log(
      "PAYMENT_MATRIX_OK: 10 scenarios; unique payments; balanced ledger; terminal Workflow late callback."
    );
  }
);
