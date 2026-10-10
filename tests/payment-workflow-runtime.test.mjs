import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createServer } from "vite";
import { Miniflare as StoreMiniflare } from "miniflare";
import { applyMigration, invoice } from "./helpers/d1.mjs";

// Use precisely the upgraded plugin's emulator, not the older standalone store-test dependency.
const pluginRequire = createRequire(
  import.meta.resolve("@cloudflare/vite-plugin")
);
const { Miniflare } = pluginRequire("miniflare");
const root = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(read, accepts, timeout = 25_000) {
  let value;
  const end = Date.now() + timeout;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(150);
  } while (Date.now() < end);
  assert.fail(`Runtime condition timed out: ${JSON.stringify(value)}`);
}

test(
  "real Workflow runtime buffers early events, matches types, and catches wait timeout",
  { timeout: 40_000 },
  async (t) => {
    const mf = new Miniflare({
      modules: true,
      compatibilityDate: "2026-06-11",
      script: `
      import { WorkflowEntrypoint } from 'cloudflare:workers';
      export class Probe extends WorkflowEntrypoint {
        async run(event, step) {
          await step.sleep('before-wait', '1 second');
          const hint = await step.waitForEvent('early-event', { type: 'payment-attempt-1', timeout: '3 seconds' });
          let timedOut = false;
          try { await step.waitForEvent('timeout-event', { type: 'never-sent', timeout: '1 second' }); }
          catch { timedOut = true; }
          return { payload: hint.payload, timedOut, instanceId: event.instanceId };
        }
      }
      export default { async fetch(request, env) {
        const instance = request.method === 'POST'
          ? await env.PROBE.create({ id: 'event-probe', params: {} }) : await env.PROBE.get('event-probe');
        if (request.method === 'POST') {
          await instance.sendEvent({ type: 'unrelated', payload: { attemptId: 'wrong' } });
          await instance.sendEvent({ type: 'payment-attempt-1', payload: { attemptId: 'persisted-attempt' } });
        }
        return Response.json(await instance.status());
      } };
    `,
      workflows: { PROBE: { name: "probe-workflow", className: "Probe" } }
    });
    t.after(() => mf.dispose());
    assert.equal(
      (await mf.dispatchFetch("https://probe.test", { method: "POST" })).status,
      200
    );
    const status = await eventually(
      async () => (await mf.dispatchFetch("https://probe.test")).json(),
      (s) => s.status === "complete"
    );
    assert.deepEqual(status.output, {
      payload: { attemptId: "persisted-attempt" },
      timedOut: true,
      instanceId: "event-probe"
    });
  }
);

test(
  "actual Vite config runs merchant PaymentWorkflow plus processor auxiliary Worker and reverse signed webhook binding",
  { timeout: 120_000 },
  async (t) => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "payment-vite-runtime-")
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
    // Seed with the existing CLI/store-test emulator (v4), then consume it in upgraded Vite (v5).
    // Only a newly created OS-temp database is used; never open the user's .wrangler directory.
    seed = new StoreMiniflare({
      modules: true,
      script: "export default { fetch() { return new Response(null) } }",
      d1Databases: { DB: "DB" },
      d1Persist: path.join(directory, "v3", "d1")
    });
    const db = await seed.getD1Database("DB");
    for (const file of (await readdir(path.join(root, "migrations"))).sort())
      await applyMigration(db, `migrations/${file}`);
    await applyMigration(db, "seed/demo.sql");
    const inv = await invoice(db, "cus_acme", "2026-09");
    const retryInvoice = await invoice(db, "cus_nimbus", "2026-09");
    await seed.dispose();
    seed = undefined;
    server = await createServer({
      configFile: path.join(root, "vite.config.ts"),
      mode: "payment-test",
      // Own dependency cache: a shared one is rebuilt whenever another Vite
      // server (a parallel test or your dev server) has a different config.
      cacheDir: path.join(directory, "vite-cache"),
      server: { host: "127.0.0.1", port: 0 },
      clearScreen: false
    });
    await server.listen();
    const address = server.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const call = async (pathname, method = "GET", body) => {
      const response = await fetch(`${origin}/api${pathname}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      const text = await response.text();
      assert.ok(response.ok, `${response.status} ${pathname}: ${text}`);
      return JSON.parse(text);
    };
    assert.equal((await call(`/payments/${inv.id}`)).status, "open");
    await call(`/payments/${inv.id}/scenarios`, "PUT", {
      scenarios: ["pending"]
    });
    const run = await call(`/payments/${inv.id}/collect`, "POST");
    assert.match(run.id, /^payment-/);
    const paid = await eventually(
      () => call(`/payments/${inv.id}`),
      (c) => c.status === "paid"
    );
    assert.equal(paid.attemptsUsed, 1);
    assert.equal(paid.paidCents, inv.totalCents);
    assert.equal(paid.reservedCents, 0);
    const complete = await eventually(
      () => call(`/payments/${inv.id}/run`),
      (s) => s.status === "complete"
    );
    assert.equal(complete.output.status, "paid");
    const processor = await eventually(
      () => call(`/payments/${inv.id}/processor`),
      (p) =>
        p.outbox.length === 2 && p.outbox.every((e) => e.state === "delivered")
    );
    assert.equal(processor.requests.length, 1);
    assert.equal(processor.requests[0].charge.status, "succeeded");
    assert.deepEqual(
      (await call("/payments/reconcile", "POST", { invoiceId: inv.id })).issues,
      []
    );
    // An outage has no webhook to rescue the first POST: genuine step.do backoff must replay its key.
    await call(`/payments/${retryInvoice.id}/scenarios`, "PUT", {
      scenarios: ["outage"]
    });
    await call(`/payments/${retryInvoice.id}/collect`, "POST");
    await eventually(
      () => call(`/payments/${retryInvoice.id}/run`),
      (s) => s.status === "complete"
    );
    const retried = await call(`/payments/${retryInvoice.id}/processor`);
    assert.equal(retried.requests.length, 1);
    assert.equal(retried.requests[0].scenario, "outage");
    assert.equal(retried.requests[0].charge.status, "succeeded");
    assert.equal((await call(`/payments/${retryInvoice.id}`)).attemptsUsed, 1);
    // A newly finalized invoice automatically launches its collection, no collect click.
    const invoiceRun = await call("/invoice-runs", "POST", {
      customerId: "cus_orbit",
      month: "2026-09"
    });
    await eventually(
      () => call(`/invoice-runs/${invoiceRun.id}`),
      (s) => s.status === "complete"
    );
    const automatic = await eventually(
      () => call("/payments/inv_cus_orbit_2026-09"),
      (c) => c.status === "paid"
    );
    assert.equal(automatic.attemptsUsed, 1);
    // Explorer is a real local route in the targeted upgrade, not a fabricated app screen.
    const explorer = await fetch(`${origin}/cdn-cgi/explorer`);
    assert.equal(explorer.status, 200);
    assert.match(
      await explorer.text(),
      /<title>Cloudflare Local Explorer<\/title>/
    );
  }
);
