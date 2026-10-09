import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import {
  DEMO_PROCESSOR_TOKEN,
  DEMO_WEBHOOK_SECRET
} from "../src/payments/protocol.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const merchantSource = `
import { verifyProcessorWebhook, DEMO_WEBHOOK_SECRET } from './src/payments/protocol.ts';
const events = [];
export default { async fetch(request, env) {
  if (new URL(request.url).pathname === '/events') return Response.json(events);
  if (env.FAIL_DELIVERY) return new Response(null, { status: 503 });
  if (new URL(request.url).pathname !== '/api/payments/webhook') return new Response(null, { status: 404 });
  const raw = await request.text();
  if (!await verifyProcessorWebhook(raw, request.headers, DEMO_WEBHOOK_SECRET)) return new Response(null, { status: 401 });
  events.push(JSON.parse(raw));
  return new Response(null, { status: 204 });
} };
`;
async function eventually(read, accept, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  let value;
  do {
    value = await read();
    if (accept(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  assert.fail(
    `Condition timed out; last observation: ${JSON.stringify(value)}`
  );
}

test("processor Worker uses real DO SQLite/alarms and signed service-binding callbacks, with durable lost-response recovery", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "processor-runtime-"));
  let mf;
  t.after(async () => {
    await mf?.dispose();
    await rm(directory, { recursive: true, force: true });
  });
  const bundleOptions = {
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    external: ["cloudflare:workers"],
    logLevel: "silent"
  };
  const processor = (
    await build({
      ...bundleOptions,
      absWorkingDir: root,
      entryPoints: ["processor/worker.ts"]
    })
  ).outputFiles[0].text;
  const merchant = (
    await build({
      ...bundleOptions,
      stdin: {
        contents: merchantSource,
        resolveDir: root,
        sourcefile: "processor-test-merchant.js"
      }
    })
  ).outputFiles[0].text;
  const start = (failDelivery = false) =>
    new Miniflare({
      durableObjectsPersist: path.join(directory, "processor-do"),
      workers: [
        {
          name: "mock-payment-processor",
          modules: true,
          script: processor,
          compatibilityDate: "2026-06-11",
          bindings: {
            PROCESSOR_TOKEN: DEMO_PROCESSOR_TOKEN,
            PROCESSOR_WEBHOOK_SECRET: DEMO_WEBHOOK_SECRET
          },
          durableObjects: {
            PROCESSOR_STATE: { className: "ProcessorState", useSQLite: true }
          },
          serviceBindings: { MERCHANT: "merchant-test" }
        },
        {
          name: "merchant-test",
          modules: true,
          script: merchant,
          compatibilityDate: "2026-06-11",
          bindings: { FAIL_DELIVERY: failDelivery }
        }
      ]
    });
  mf = start(true);
  const call = (pathname, method = "GET", body) =>
    mf.dispatchFetch(`https://processor.test${pathname}`, {
      method,
      headers: {
        authorization: `Bearer ${DEMO_PROCESSOR_TOKEN}`,
        "content-type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  const inspect = async () =>
    (await call("/demo/inspect?invoiceId=runtime-invoice")).json();
  const request = {
    invoiceId: "runtime-invoice",
    attemptId: "runtime-attempt",
    idempotencyKey: "runtime-key",
    amountCents: 2000,
    currency: "USD",
    methodVersion: 1
  };
  assert.equal(
    (await mf.dispatchFetch("https://processor.test/charges")).status,
    401
  );
  assert.equal(
    (
      await call("/demo/scenarios", "PUT", {
        invoiceId: request.invoiceId,
        scenarios: [
          "lost_response",
          "pending",
          "duplicate_webhook",
          "lost_webhook"
        ]
      })
    ).status,
    200
  );
  assert.equal((await call("/charges", "POST", request)).status, 504);
  const original = (await inspect()).requests[0].charge;
  await eventually(
    inspect,
    (value) =>
      value.outbox[0].attempts >= 1 && value.outbox[0].lastError !== null
  );
  await mf.dispose();
  mf = undefined;
  mf = start();
  // Inspection does not arm alarms: persisted alarm/outbox must recover by itself.
  await eventually(inspect, (value) => value.outbox[0].state === "delivered");
  const recovered = await (await call("/charges", "POST", request)).json();
  assert.equal(recovered.replayed, true);
  assert.deepEqual(recovered.charge, original);
  await eventually(inspect, (value) => value.outbox[0].state === "delivered");
  assert.equal((await inspect()).requests.length, 1);

  const pending = {
    ...request,
    attemptId: "pending-attempt",
    idempotencyKey: "pending-key"
  };
  assert.equal(
    (await (await call("/charges", "POST", pending)).json()).charge.status,
    "pending"
  );
  // Do not query charge status here: actual alarms, not HTTP observation, advance it.
  await eventually(
    inspect,
    (value) =>
      value.requests.find((row) => row.request.attemptId === pending.attemptId)
        ?.charge.status === "succeeded"
  );
  await eventually(inspect, (value) =>
    value.outbox
      .filter((row) => row.event.charge.attemptId === pending.attemptId)
      .every((row) => row.state === "delivered")
  );
  const callbackWorker = await mf.getWorker("merchant-test");
  const pendingEvents = (
    await (await callbackWorker.fetch("https://merchant.test/events")).json()
  ).filter((event) => event.charge.attemptId === pending.attemptId);
  assert.equal(pendingEvents.length, 2);
  assert.deepEqual(pendingEvents.map((event) => event.charge.status).sort(), [
    "pending",
    "succeeded"
  ]);

  await call("/charges", "POST", {
    ...request,
    attemptId: "duplicate-attempt",
    idempotencyKey: "duplicate-key"
  });
  await call("/charges", "POST", {
    ...request,
    attemptId: "lost-attempt",
    idempotencyKey: "lost-key"
  });
  await eventually(
    inspect,
    (value) =>
      value.outbox.find(
        (row) => row.event.charge.attemptId === "duplicate-attempt"
      )?.state === "delivered"
  );
  const events = await (
    await callbackWorker.fetch("https://merchant.test/events")
  ).json();
  const duplicates = events.filter(
    (event) => event.charge.attemptId === "duplicate-attempt"
  );
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates[0], duplicates[1]);
  assert.equal(
    events.filter((event) => event.charge.attemptId === "lost-attempt").length,
    0
  );
  assert.equal(
    (await inspect()).outbox.find(
      (row) => row.event.charge.attemptId === "lost-attempt"
    ).state,
    "dropped"
  );
  assert.equal(
    (await (await call("/charges?idempotencyKey=lost-key")).json()).charge
      .status,
    "succeeded"
  );
});
