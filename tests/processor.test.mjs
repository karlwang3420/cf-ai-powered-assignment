import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  Processor,
  MAX_DELIVERY_ATTEMPTS,
  PENDING_DELAY_MS
} from "../processor/core.ts";
import {
  DEMO_PROCESSOR_TOKEN,
  DEMO_WEBHOOK_SECRET,
  PROCESSOR_SIGNATURE_HEADER,
  PROCESSOR_TIMESTAMP_HEADER,
  signProcessorWebhook,
  verifyProcessorWebhook
} from "../src/payments/protocol.ts";

const payload = (overrides = {}) => ({
  invoiceId: "inv_1",
  attemptId: "attempt_1",
  idempotencyKey: "inv_1:1",
  amountCents: 2000,
  currency: "USD",
  methodVersion: 1,
  ...overrides
});
function fixture(t, callback) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let clock = Date.parse("2026-06-15T12:00:00Z");
  let alarm = null;
  const deliveries = [];
  const storage = {
    sql: {
      exec(query, ...bindings) {
        // DO SQL executes eagerly; its returned cursor is only a result reader.
        const statement = db.prepare(query);
        const rows = statement.columns().length
          ? statement.all(...bindings)
          : (statement.run(...bindings), []);
        return { toArray: () => rows };
      }
    },
    transactionSync(fn) {
      db.exec("BEGIN");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    async setAlarm(time) {
      alarm = time;
    },
    async deleteAlarm() {
      alarm = null;
    }
  };
  const options = {
    token: DEMO_PROCESSOR_TOKEN,
    webhookSecret: DEMO_WEBHOOK_SECRET,
    now: () => clock,
    merchant: {
      async fetch(request) {
        const raw = await request.text();
        assert.equal(
          await verifyProcessorWebhook(
            raw,
            request.headers,
            DEMO_WEBHOOK_SECRET,
            Math.floor(clock / 1000)
          ),
          true
        );
        deliveries.push({
          raw,
          headers: new Headers(request.headers),
          event: JSON.parse(raw)
        });
        return callback
          ? callback(request, deliveries.length)
          : new Response(null, { status: 204 });
      }
    }
  };
  let processor = new Processor(storage, options);
  return {
    deliveries,
    db,
    get processor() {
      return processor;
    },
    get alarmAt() {
      return alarm;
    },
    get now() {
      return clock;
    },
    advance(ms) {
      clock += ms;
    },
    restart() {
      processor = new Processor(storage, options);
    },
    async call(path, method = "GET", value, token = DEMO_PROCESSOR_TOKEN) {
      return processor.fetch(
        new Request(`https://processor.test${path}`, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json"
          },
          body: value === undefined ? undefined : JSON.stringify(value)
        })
      );
    },
    async scenario(scenarios) {
      assert.equal(
        (
          await this.call("/demo/scenarios", "PUT", {
            invoiceId: "inv_1",
            scenarios
          })
        ).status,
        200
      );
    },
    async inspect() {
      return (await this.call("/demo/inspect?invoiceId=inv_1")).json();
    },
    async tick() {
      if (alarm !== null) clock = Math.max(clock, alarm);
      await processor.alarm();
    }
  };
}

test("processor authenticates every endpoint and bounds demo controls/input", async (t) => {
  const f = fixture(t);
  for (const [path, method, value] of [
    ["/charges", "POST", payload()],
    ["/charges?idempotencyKey=absent", "GET"],
    ["/demo/inspect?invoiceId=inv_1", "GET"],
    ["/demo/scenarios", "PUT", {}],
    ["/demo/outbox/retry", "POST", {}]
  ])
    assert.equal((await f.call(path, method, value, "wrong")).status, 401);
  for (const value of [
    payload({ amountCents: 0 }),
    payload({ amountCents: 2.1 }),
    payload({ amountCents: Number.MAX_SAFE_INTEGER + 1 }),
    payload({ currency: "EUR" }),
    payload({ methodVersion: 0 }),
    payload({ invoiceId: " " }),
    { ...payload(), surprise: true }
  ]) {
    assert.equal((await f.call("/charges", "POST", value)).status, 400);
  }
  assert.equal(
    (
      await f.call("/demo/scenarios", "PUT", {
        invoiceId: "inv_1",
        scenarios: Array(21).fill("success")
      })
    ).status,
    400
  );
  assert.equal(
    (
      await f.call("/demo/scenarios", "PUT", {
        invoiceId: "inv_1",
        scenarios: ["bogus"]
      })
    ).status,
    400
  );
  assert.equal(
    (await f.call("/charges", "POST", { value: "x".repeat(17000) })).status,
    413
  );
  assert.equal((await f.call("/charges?idempotencyKey=absent")).status, 404);
  assert.equal((await f.inspect()).requests.length, 0);
});

test("processor same-key replay canonicalizes order, rejects every changed valid field and another key for the attempt", async (t) => {
  const f = fixture(t);
  const responses = await Promise.all(
    Array.from({ length: 12 }, () => f.call("/charges", "POST", payload()))
  );
  assert.equal(
    responses.filter((response) => response.status === 201).length,
    1
  );
  const charges = await Promise.all(
    responses.map((response) => response.json())
  );
  assert.equal(
    new Set(charges.map((response) => response.charge.processorPaymentId)).size,
    1
  );
  const reversed = Object.fromEntries(Object.entries(payload()).reverse());
  assert.equal(
    (await (await f.call("/charges", "POST", reversed)).json()).replayed,
    true
  );
  for (const change of [
    { amountCents: 2001 },
    { invoiceId: "other" },
    { attemptId: "other" },
    { methodVersion: 2 }
  ]) {
    const response = await f.call("/charges", "POST", payload(change));
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, "idempotency_conflict");
  }
  assert.equal(
    (await f.call("/charges", "POST", payload({ idempotencyKey: "other" })))
      .status,
    409
  );
  const inspect = await f.inspect();
  assert.equal(inspect.requests.length, 1);
  assert.equal(inspect.outbox.length, 1);
  assert.equal(inspect.keyRetention, "indefinite");
});

test("processor lost response commits exactly one charge/outbox and survives restart with original-key/ID recovery", async (t) => {
  const f = fixture(t);
  await f.scenario(["lost_response"]);
  assert.equal((await f.call("/charges", "POST", payload())).status, 504);
  assert.notEqual(f.alarmAt, null);
  f.restart();
  const lookup = await (
    await f.call("/charges?idempotencyKey=inv_1%3A1")
  ).json();
  assert.equal(lookup.charge.status, "succeeded");
  const replay = await (await f.call("/charges", "POST", payload())).json();
  assert.deepEqual(replay, { ...lookup, replayed: true });
  assert.deepEqual(
    await (await f.call(`/charges/${lookup.charge.processorPaymentId}`)).json(),
    lookup
  );
  await f.tick();
  assert.equal(f.deliveries.length, 1);
  assert.deepEqual(f.deliveries[0].event.charge, lookup.charge);
  assert.equal((await f.inspect()).requests.length, 1);
});

test("processor transient outage pins payload and scenario before commit; replay does not consume next scenario", async (t) => {
  const f = fixture(t);
  await f.scenario(["outage", "soft_decline"]);
  assert.equal((await f.call("/charges", "POST", payload())).status, 503);
  assert.equal((await f.inspect()).requests[0].charge, null);
  assert.equal((await f.call("/charges?idempotencyKey=inv_1%3A1")).status, 503);
  f.restart();
  assert.equal(
    (await f.call("/charges", "POST", payload({ amountCents: 1 }))).status,
    409
  );
  const replay = await (await f.call("/charges", "POST", payload())).json();
  assert.equal(replay.charge.status, "succeeded");
  assert.equal(replay.replayed, false);
  assert.deepEqual((await f.inspect()).scenarios, ["soft_decline"]);
});

test("processor decline-then-success presets emit terminal signed events and echo a newer method version", async (t) => {
  const f = fixture(t);
  await f.scenario(["soft_decline", "hard_decline", "success"]);
  for (const [index, status, declineType] of [
    [1, "declined", "soft"],
    [2, "declined", "hard"],
    [3, "succeeded", undefined]
  ]) {
    const request = payload({
      attemptId: `attempt_${index}`,
      idempotencyKey: `inv_1:${index}`,
      methodVersion: index === 3 ? 2 : 1
    });
    const { charge } = await (await f.call("/charges", "POST", request)).json();
    assert.equal(charge.status, status);
    assert.equal(charge.declineType, declineType);
    for (const [key, value] of Object.entries(request))
      assert.equal(charge[key], value);
  }
  await f.tick();
  assert.equal(f.deliveries.length, 3);
  assert.deepEqual(
    f.deliveries.map(({ event }) => event.charge.status),
    ["declined", "declined", "succeeded"]
  );
});

test("processor pending advances durably by alarm, retains identity, and never regresses on replay", async (t) => {
  const f = fixture(t);
  await f.scenario(["pending"]);
  const { charge } = await (await f.call("/charges", "POST", payload())).json();
  assert.equal(charge.status, "pending");
  await f.tick(); // pending event before progression
  f.restart();
  f.advance(PENDING_DELAY_MS);
  await f.tick();
  const resolved = await (
    await f.call(`/charges/${charge.processorPaymentId}`)
  ).json();
  assert.deepEqual(resolved.charge, { ...charge, status: "succeeded" });
  assert.equal(
    (await (await f.call("/charges", "POST", payload())).json()).charge.status,
    "succeeded"
  );
  assert.deepEqual(
    f.deliveries.map(({ event }) => event.charge.status),
    ["pending", "succeeded"]
  );
  assert.equal(new Set(f.deliveries.map(({ event }) => event.eventId)).size, 2);
  assert.equal((await f.inspect()).requests.length, 1);
});

test("processor pending can also resolve through status lookup if its alarm has not run", async (t) => {
  const f = fixture(t);
  await f.scenario(["pending"]);
  await f.call("/charges", "POST", payload());
  f.advance(PENDING_DELAY_MS + 1);
  assert.equal(
    (await (await f.call("/charges?idempotencyKey=inv_1%3A1")).json()).charge
      .status,
    "succeeded"
  );
  assert.equal((await f.inspect()).outbox.length, 2);
});

test("processor unresolved_pending is deterministic across restarts and arbitrary elapsed time", async (t) => {
  const f = fixture(t);
  await f.scenario(["unresolved_pending"]);
  await f.call("/charges", "POST", payload());
  await f.tick();
  for (let i = 0; i < 4; i++) {
    f.restart();
    f.advance(365 * 24 * 60 * 60 * 1000);
    assert.equal(
      (await (await f.call("/charges?idempotencyKey=inv_1%3A1")).json()).charge
        .status,
      "pending"
    );
    assert.equal(
      (await (await f.call("/charges", "POST", payload())).json()).charge
        .status,
      "pending"
    );
  }
  assert.equal((await f.inspect()).requests.length, 1);
  assert.equal((await f.inspect()).outbox.length, 1);
  assert.equal(f.alarmAt, null);
});

test("processor deliberately duplicates the same event and deliberately drops lost webhook while retaining status", async (t) => {
  const f = fixture(t);
  await f.scenario(["duplicate_webhook", "lost_webhook"]);
  await f.call("/charges", "POST", payload());
  await f.call(
    "/charges",
    "POST",
    payload({ attemptId: "attempt_2", idempotencyKey: "inv_1:2" })
  );
  await f.tick();
  f.restart();
  await f.tick();
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.deliveries[0].raw, f.deliveries[1].raw);
  const inspect = await f.inspect();
  assert.equal(
    inspect.outbox.find((row) => row.event.charge.attemptId === "attempt_1")
      .state,
    "delivered"
  );
  const lost = inspect.outbox.find(
    (row) => row.event.charge.attemptId === "attempt_2"
  );
  assert.equal(lost.state, "dropped");
  assert.equal(lost.attempts, 0);
  assert.equal(
    (await (await f.call("/charges?idempotencyKey=inv_1%3A2")).json()).charge
      .status,
    "succeeded"
  );
});

test("processor durable retry retains event/body, renews signature timestamp and resumes after restart", async (t) => {
  const f = fixture(
    t,
    (_request, count) => new Response(null, { status: count === 1 ? 503 : 204 })
  );
  await f.call("/charges", "POST", payload());
  await f.tick();
  assert.equal((await f.inspect()).outbox[0].state, "queued");
  f.restart();
  f.advance(600_000);
  await f.tick();
  assert.equal(f.deliveries[0].raw, f.deliveries[1].raw);
  assert.notEqual(
    f.deliveries[0].headers.get(PROCESSOR_TIMESTAMP_HEADER),
    f.deliveries[1].headers.get(PROCESSOR_TIMESTAMP_HEADER)
  );
  assert.equal(
    await verifyProcessorWebhook(
      f.deliveries[0].raw,
      f.deliveries[0].headers,
      DEMO_WEBHOOK_SECRET,
      Math.floor(f.now / 1000)
    ),
    false
  );
  assert.equal((await f.inspect()).outbox[0].state, "delivered");
});

test("processor bounded delivery exhaustion remains inspectable and explicitly recoverable", async (t) => {
  let healthy = false;
  const f = fixture(
    t,
    () => new Response(null, { status: healthy ? 204 : 500 })
  );
  await f.call("/charges", "POST", payload());
  for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) await f.tick();
  const exhausted = (await f.inspect()).outbox[0];
  assert.equal(exhausted.state, "exhausted");
  assert.equal(exhausted.attempts, MAX_DELIVERY_ATTEMPTS);
  assert.equal(f.alarmAt, null);
  f.restart();
  healthy = true;
  assert.equal(
    (
      await f.call("/demo/outbox/retry", "POST", {
        eventId: exhausted.event.eventId
      })
    ).status,
    200
  );
  await f.tick();
  assert.equal((await f.inspect()).outbox[0].state, "delivered");
  assert.equal(f.deliveries.at(-1).event.eventId, exhausted.event.eventId);
  assert.equal(
    (
      await f.call("/demo/outbox/retry", "POST", {
        eventId: exhausted.event.eventId
      })
    ).status,
    409
  );
});

test("processor in-flight callback crash lease redelivers the original event without stranding the outbox", async (t) => {
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let finish;
  const suspended = new Promise((resolve) => {
    finish = resolve;
  });
  const f = fixture(t, (_request, count) => {
    if (count === 1) {
      entered();
      return suspended;
    }
    return new Response(null, { status: 204 });
  });
  await f.call("/charges", "POST", payload());
  const oldAlarm = f.tick();
  await started;
  const leased = (await f.inspect()).outbox[0];
  assert.equal(leased.attempts, 1);
  assert.ok(leased.dueAt > f.now);
  assert.notEqual(f.alarmAt, null);
  f.restart();
  f.advance(31_000);
  await f.tick();
  finish(new Response(null, { status: 204 }));
  await oldAlarm;
  assert.equal(f.deliveries.length, 2);
  assert.equal(f.deliveries[0].raw, f.deliveries[1].raw);
  assert.equal((await f.inspect()).outbox[0].state, "delivered");
});

test("processor protocol HMAC covers exact raw body and timestamp; rejects tamper, stale/future and malformed signatures", async () => {
  const raw = '{"amountCents":2000}';
  const seconds = 1_780_000_000;
  const headers = new Headers(
    await signProcessorWebhook(raw, DEMO_WEBHOOK_SECRET, seconds)
  );
  assert.equal(
    headers.get(PROCESSOR_SIGNATURE_HEADER),
    `v1=${createHmac("sha256", DEMO_WEBHOOK_SECRET).update(`${seconds}.${raw}`).digest("hex")}`
  );
  assert.equal(
    await verifyProcessorWebhook(raw, headers, DEMO_WEBHOOK_SECRET, seconds),
    true
  );
  for (const body of ['{"amountCents":2001}', raw + " "])
    assert.equal(
      await verifyProcessorWebhook(body, headers, DEMO_WEBHOOK_SECRET, seconds),
      false
    );
  assert.equal(
    await verifyProcessorWebhook(raw, headers, "wrong", seconds),
    false
  );
  assert.equal(
    await verifyProcessorWebhook(
      raw,
      headers,
      DEMO_WEBHOOK_SECRET,
      seconds + 301
    ),
    false
  );
  assert.equal(
    await verifyProcessorWebhook(
      raw,
      headers,
      DEMO_WEBHOOK_SECRET,
      seconds - 301
    ),
    false
  );
  for (const value of ["", "v1=zzz", "v2=" + "a".repeat(64)]) {
    const modified = new Headers(headers);
    modified.set(PROCESSOR_SIGNATURE_HEADER, value);
    assert.equal(
      await verifyProcessorWebhook(raw, modified, DEMO_WEBHOOK_SECRET, seconds),
      false
    );
  }
  headers.set(PROCESSOR_TIMESTAMP_HEADER, String(seconds + 1));
  assert.equal(
    await verifyProcessorWebhook(raw, headers, DEMO_WEBHOOK_SECRET, seconds),
    false
  );
});

test("processor atomically rolls back charge/progression when durable event insertion fails", async (t) => {
  const f = fixture(t);
  await f.scenario(["pending"]);
  f.db.exec(
    `CREATE TRIGGER fail_event BEFORE INSERT ON processor_outbox BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`
  );
  await assert.rejects(
    f.call("/charges", "POST", payload()),
    /injected event failure/
  );
  let state = await f.inspect();
  assert.equal(state.requests.length, 0);
  assert.equal(state.outbox.length, 0);
  assert.deepEqual(state.scenarios, ["pending"]);
  assert.notEqual(f.alarmAt, null);
  f.db.exec("DROP TRIGGER fail_event");
  await f.call("/charges", "POST", payload());
  f.advance(PENDING_DELAY_MS + 1);
  f.db.exec(
    `CREATE TRIGGER fail_event BEFORE INSERT ON processor_outbox BEGIN SELECT RAISE(ABORT, 'injected event failure'); END`
  );
  await assert.rejects(f.processor.alarm(), /injected event failure/);
  state = await f.inspect();
  assert.equal(state.requests[0].charge.status, "pending");
  assert.equal(state.outbox.length, 1);
  f.restart();
  f.db.exec("DROP TRIGGER fail_event");
  await f.tick();
  state = await f.inspect();
  assert.equal(state.requests[0].charge.status, "succeeded");
  assert.equal(state.outbox.length, 2);
  assert.equal(state.requests.length, 1);
});

test("processor debug reset forgets only that invoice so the same key charges afresh", async (t) => {
  const f = fixture(t);
  await f.scenario(["success", "soft_decline"]);
  const first = await (await f.call("/charges", "POST", payload())).json();
  assert.equal(first.charge.status, "succeeded");
  const other = payload({
    invoiceId: "inv_2",
    attemptId: "attempt_2",
    idempotencyKey: "inv_2:1"
  });
  assert.ok((await f.call("/charges", "POST", other)).ok);
  assert.equal(
    (await f.call("/demo/reset", "POST", { invoiceId: "inv_1" })).status,
    200
  );
  const cleared = await f.inspect();
  assert.deepEqual(cleared.requests, []);
  assert.deepEqual(cleared.outbox, []);
  assert.deepEqual(cleared.scenarios, []);
  const again = await (await f.call("/charges", "POST", payload())).json();
  assert.notEqual(
    again.charge.processorPaymentId,
    first.charge.processorPaymentId
  );
  assert.notEqual(again.replayed, true);
  assert.equal(
    (await (await f.call("/charges?idempotencyKey=inv_2%3A1")).json()).charge
      .status,
    "succeeded",
    "other invoices keep their keys"
  );
  assert.equal(
    (await f.call("/demo/reset", "POST", { invoiceId: "inv_1" }, "wrong"))
      .status,
    401
  );
});

test("processor reset-all forgets every invoice and its pending deliveries", async (t) => {
  const f = fixture(t);
  await f.scenario(["pending", "success"]);
  const pending = await (await f.call("/charges", "POST", payload())).json();
  assert.equal(pending.charge.status, "pending");
  const other = payload({
    invoiceId: "inv_2",
    attemptId: "attempt_2",
    idempotencyKey: "inv_2:1"
  });
  assert.ok((await f.call("/charges", "POST", other)).ok);
  assert.notEqual(f.alarmAt, null, "a delivery is scheduled");
  assert.equal(
    (await f.call("/demo/reset-all", "POST", {}, "wrong")).status,
    401
  );
  assert.equal((await f.call("/demo/reset-all", "POST", {})).status, 200);
  for (const table of [
    "processor_keys",
    "processor_outbox",
    "processor_scenarios"
  ])
    assert.equal(
      f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,
      0,
      table
    );
  assert.equal(f.alarmAt, null, "no callback into the reseeded merchant");
  f.advance(PENDING_DELAY_MS * 2);
  await f.processor.alarm();
  assert.equal(f.deliveries.length, 0);
  const again = await (await f.call("/charges", "POST", payload())).json();
  assert.notEqual(
    again.charge.processorPaymentId,
    pending.charge.processorPaymentId,
    "the same key charges afresh"
  );
});

test("processor reset-all waits for a webhook already being sent, then sends no more", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = () => resolve(new Response(null, { status: 204 }));
  });
  const f = fixture(t, () => held);
  for (const n of [1, 2])
    assert.ok(
      (
        await f.call(
          "/charges",
          "POST",
          payload({
            invoiceId: `inv_${n}`,
            attemptId: `attempt_${n}`,
            idempotencyKey: `inv_${n}:1`
          })
        )
      ).ok
    );
  const ticks = async (n = 20) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
  };
  const alarm = f.processor.alarm();
  while (f.deliveries.length === 0) await ticks(1);

  let resetDone = false;
  const reset = f.call("/demo/reset-all", "POST", {}).then((response) => {
    resetDone = true;
    return response;
  });
  await ticks();
  assert.equal(resetDone, false, "the reset waits for the delivery in flight");
  release();
  await alarm;
  assert.equal((await reset).status, 200);
  assert.equal(f.deliveries.length, 1, "the second webhook is never sent");
  assert.equal(
    f.db.prepare("SELECT COUNT(*) AS n FROM processor_outbox").get().n,
    0
  );
  assert.equal(f.alarmAt, null);
  await f.processor.alarm();
  assert.equal(f.deliveries.length, 1);
});

test("processor demo settle resolves only a pending charge through the normal signed webhook", async (t) => {
  const f = fixture(t);
  assert.equal(
    (
      await f.call("/demo/settle", "POST", {
        invoiceId: "inv_1",
        outcome: "succeeded"
      })
    ).status,
    409,
    "nothing pending yet"
  );
  await f.scenario(["unresolved_pending"]);
  const pending = await (await f.call("/charges", "POST", payload())).json();
  assert.equal(pending.charge.status, "pending");
  await f.tick();
  assert.equal(f.deliveries.length, 1, "pending webhook");
  assert.equal(
    (
      await f.call("/demo/settle", "POST", {
        invoiceId: "inv_1",
        outcome: "maybe"
      })
    ).status,
    400
  );
  const settled = await (
    await f.call("/demo/settle", "POST", {
      invoiceId: "inv_1",
      outcome: "soft_decline"
    })
  ).json();
  assert.equal(settled.charge.status, "declined");
  assert.equal(settled.charge.declineType, "soft");
  assert.equal(
    settled.charge.processorPaymentId,
    pending.charge.processorPaymentId
  );
  const lookup = await (
    await f.call("/charges?idempotencyKey=inv_1%3A1")
  ).json();
  assert.deepEqual(lookup.charge, settled.charge, "status lookup agrees");
  await f.tick();
  assert.equal(f.deliveries.length, 2);
  assert.deepEqual(f.deliveries[1].event.charge, settled.charge);
  assert.equal(
    (
      await f.call("/demo/settle", "POST", {
        invoiceId: "inv_1",
        outcome: "succeeded"
      })
    ).status,
    409,
    "terminal outcomes stay immutable"
  );
});
