// Real repository Vite configuration, two Workers, real Workflow sleeps/events and fresh persistence.
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";
import { Miniflare as StoreMiniflare } from "miniflare";
import { applyMigration, invoice } from "./helpers/d1.mjs";
import { checkPaymentLayout } from "./helpers/payment-layout.mjs";

const exec = promisify(execFile);
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
    await seed.dispose();
    seed = undefined;
    server = await createServer({
      configFile: path.resolve("vite.config.ts"),
      mode: "payment-test",
      // Own dependency cache: a shared one is rebuilt whenever another Vite
      // server (a parallel test or your dev server) has a different config.
      cacheDir: path.join(directory, "vite-cache"),
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
    // Mock processor control on the invoice's latest committed charge
    const latest = async (name) =>
      (await call(route(name, "/processor"))).requests.find((r) => r.charge);
    const processor = async (name, action, outcome) => {
      const { charge } = await latest(name);
      return call(route(name, `/processor/${action}`), "POST", {
        processorPaymentId: charge.processorPaymentId,
        ...(outcome ? { outcome } : {})
      });
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
      // Stays pending until the test settles it, after the run gives up
      late: ["unresolved_pending"],
      credit: ["hard_decline"]
    };
    for (const [name, queue] of Object.entries(scenarios))
      await call(route(name, "/scenarios"), "PUT", { scenarios: queue });
    // Watch the card waits before collecting: the waits are only seconds long,
    // and under load the remaining collects can outlast them.
    const cardWaits = Promise.all([
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
    // Awaited below; this only keeps an early failure from going unhandled.
    cardWaits.catch(() => {});
    for (const name of names) await call(route(name, "/collect"), "POST");
    await cardWaits;
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
    // Resume never passes the automatic limit; an admin retry adds one attempt
    await call(route("exhausted", "/scenarios"), "PUT", {
      scenarios: ["soft_decline"]
    });
    const manual = await call(route("exhausted", "/retry"), "POST");
    assert.equal(manual.started, true);
    await eventually(
      () => call(route("exhausted", "/run")),
      (r) => r.id === manual.id && r.status === "complete",
      150_000
    );
    const declinedAgain = await read("exhausted");
    assert.deepEqual(
      [
        declinedAgain.status,
        declinedAgain.attemptsUsed,
        declinedAgain.attemptLimit
      ],
      ["past_due", 5, 5]
    );
    // The processor turns that decline into a late success; its signed
    // webhook posts the payment once, with no new charge
    assert.deepEqual((await latest("exhausted")).actions, [
      "succeeded",
      "notify"
    ]);
    await processor("exhausted", "decide", "succeeded");
    const lateSuccess = await eventually(
      () => read("exhausted"),
      (p) => p.status === "paid",
      60_000
    );
    assert.deepEqual(
      [
        lateSuccess.paidCents,
        lateSuccess.attemptsUsed,
        lateSuccess.hasConflict
      ],
      [invoices.exhausted.totalCents, 5, 0]
    );
    assert.equal(
      (await call(route("exhausted", "/processor"))).requests.length,
      5
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
    // Notify sends the dropped success as a new event; it changes no money
    const resent = await processor("lost_webhook", "notify");
    await eventually(
      () => call(route("lost_webhook", "/processor")),
      (p) =>
        p.outbox.find((e) => e.event.eventId === resent.eventId)?.state ===
        "delivered"
    );
    const lostWebhook = await read("lost_webhook");
    assert.equal(lostWebhook.paidCents, invoices.lost_webhook.totalCents);
    assert.ok(
      lostWebhook.timeline.some(
        (e) =>
          e.kind === "webhook_received" && e.message.includes(resent.eventId)
      )
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
    // The processor decides only now; its signed webhook brings the success
    await processor("late", "decide", "succeeded");
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
    await checkPaymentLayout(origin, invoices.success.id);
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
