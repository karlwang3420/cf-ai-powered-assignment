import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { Miniflare } from "miniflare";
import { invoice } from "./helpers/d1.mjs";
import { issueCredit } from "../src/billing/store.ts";

const exec = promisify(execFile);
const cli = (...args) =>
  exec(process.execPath, ["scripts/billing.mjs", ...args], { timeout: 60_000 });

test(
  "billing CLI setup preserves existing invoices, credits and omitted seed rows",
  { timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "billing-cli-"));
    let mf;
    t.after(async () => {
      await mf?.dispose();
      await rm(directory, { recursive: true, force: true });
    });
    const open = async () => {
      mf = new Miniflare({
        modules: true,
        script: "export default { fetch() { return new Response(null) } }",
        d1Databases: { DB: "DB" },
        d1Persist: path.join(directory, "v3", "d1")
      });
      return mf.getD1Database("DB");
    };
    await cli("setup", `--persist-to=${directory}`);
    let db = await open();
    const inv = await invoice(db, "cus_acme", "2026-09");
    await issueCredit(db, {
      id: "preserved-credit",
      invoiceId: inv.id,
      amountCents: 100,
      reason: "Approved fixture",
      approvedBy: "test"
    });
    await db
      .prepare(
        "DELETE FROM usage_events WHERE id = 'seed:cus_orbit:workers_requests:2026-08-01'"
      )
      .run();
    const snapshot = async () =>
      Promise.all(
        [
          "invoices",
          "credits",
          "ledger_entries",
          "usage_events",
          "payment_collections"
        ].map(
          async (table) =>
            (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
              .results
        )
      );
    const before = await snapshot();
    await mf.dispose();
    mf = undefined;
    const setup = await cli("setup", `--persist-to=${directory}`);
    assert.match(
      setup.stdout,
      /existing customers\/data preserved \(no demo reseed\)/
    );
    db = await open();
    assert.deepEqual(await snapshot(), before);
  }
);

test("payment CLI uses running API, encodes IDs, makes resume explicit and fails unresolved checks", async (t) => {
  const calls = [];
  let unresolved = false;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    calls.push({
      method: request.method,
      url: request.url,
      body: body ? JSON.parse(body) : undefined
    });
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        issues: [],
        inbox: [],
        checks: unresolved ? [{ result: "unresolved" }] : []
      })
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `--url=http://127.0.0.1:${server.address().port}`;
  await cli("payments", "customer/a", url);
  await cli("payment", "invoice/a", url);
  await cli("payment-timeline", "invoice/a", url);
  await cli("payment-processor", "invoice/a", url);
  await cli("collect", "invoice/a", url);
  await cli("reconcile-payments", "invoice/a", url);
  await cli("reconcile-payments", "invoice/a", "--resume", url);
  await cli("reset-demo", url);
  assert.deepEqual(
    calls.map((c) => [c.method, c.url]),
    [
      ["GET", "/api/payments?customerId=customer%2Fa"],
      ["GET", "/api/payments/invoice%2Fa"],
      ["GET", "/api/payments/invoice%2Fa/timeline"],
      ["GET", "/api/payments/invoice%2Fa/processor"],
      ["POST", "/api/payments/invoice%2Fa/collect"],
      ["POST", "/api/payments/reconcile"],
      ["POST", "/api/payments/reconcile"],
      ["POST", "/api/demo/reset"]
    ]
  );
  assert.deepEqual(calls[5].body, { invoiceId: "invoice/a", resume: false });
  assert.deepEqual(calls[6].body, { invoiceId: "invoice/a", resume: true });
  unresolved = true;
  await assert.rejects(
    cli("reconcile-payments", url),
    (e) => e.code === 1 && e.stdout.includes("unresolved")
  );
  await assert.rejects(cli("payment", url), (e) =>
    e.stderr.includes("requires an invoice ID")
  );
  await assert.rejects(cli("payments", "--url=https://example.com"), (e) =>
    e.stderr.includes("loopback")
  );
});
