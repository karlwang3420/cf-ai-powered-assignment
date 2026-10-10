import assert from "node:assert/strict";
import test from "node:test";
import { runPaymentCollection } from "../src/payments/collection.ts";
import {
  chargePayload,
  retryCollection,
  startCollection
} from "../src/payments/service.ts";
import {
  applyPaymentOutcome,
  claimCollection,
  getPaymentCollection,
  recordCollectionNotice,
  preparePaymentAttempt,
  updatePaymentMethod
} from "../src/billing/payments.ts";
import { issueCredit } from "../src/billing/store.ts";
import { database, invoice } from "./helpers/d1.mjs";

function workflow() {
  const instances = new Map();
  return {
    instances,
    async create({ id, params }) {
      if (instances.has(id)) throw new Error("already exists");
      const instance = {
        id,
        params,
        status: async () => ({ status: "running" }),
        sendEvent: async () => {}
      };
      instances.set(id, instance);
      return instance;
    },
    async get(id) {
      if (!instances.has(id)) throw new Error("missing");
      return instances.get(id);
    }
  };
}
function processor(scenarios) {
  const charges = new Map();
  const requests = [];
  let posts = 0,
    lookups = 0;
  return {
    charges,
    requests,
    get posts() {
      return posts;
    },
    get lookups() {
      return lookups;
    },
    async fetch(request) {
      if (new URL(request.url).pathname === "/demo/inspect")
        return Response.json({ keyRetention: "indefinite" });
      if (request.method === "GET") {
        lookups++;
        const charge = charges.get(
          new URL(request.url).searchParams.get("idempotencyKey")
        );
        return charge
          ? Response.json({ charge })
          : new Response(null, { status: 404 });
      }
      posts++;
      const input = await request.json();
      requests.push(input);
      // Same-key replay, flagged like the real mock processor does.
      if (charges.has(input.idempotencyKey))
        return Response.json({
          charge: charges.get(input.idempotencyKey),
          replayed: true
        });
      const scenario = scenarios[Math.min(charges.size, scenarios.length - 1)];
      if (scenario === "unavailable")
        return new Response(null, { status: 503 });
      const charge = {
        ...input,
        processorPaymentId: `processor-${charges.size + 1}`,
        status:
          scenario === "hard" || scenario === "soft"
            ? "declined"
            : scenario === "pending"
              ? "pending"
              : "succeeded",
        ...(scenario === "hard" || scenario === "soft"
          ? { declineType: scenario }
          : {})
      };
      charges.set(input.idempotencyKey, charge);
      return scenario === "lost"
        ? new Response(null, { status: 504 })
        : Response.json({ charge });
    }
  };
}
function steps(t, onWait = async () => {}) {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const calls = [];
  const names = new Set();
  return {
    calls,
    async do(name, config, fn) {
      assert.ok(!names.has(name), `duplicate checkpoint ${name}`);
      names.add(name);
      calls.push(["do", name]);
      if (!fn) fn = config;
      let last;
      for (let n = 0; n <= (config.retries?.limit ?? 0); n++) {
        try {
          return await fn();
        } catch (e) {
          last = e;
        }
      }
      throw last;
    },
    async sleep(name, ms) {
      calls.push(["sleep", name]);
      clock += ms;
    },
    async sleepUntil(name, date) {
      assert.ok(
        Number(date) > clock,
        "real runtime rejects sleepUntil in the past"
      );
      calls.push(["sleepUntil", name]);
      clock = Number(date);
    },
    async waitForEvent(name, options) {
      calls.push(["waitForEvent", name, options]);
      await onWait(options);
      clock += options.timeout;
      throw new Error("event timeout");
    }
  };
}
async function setup(t, scenarios) {
  const DB = await database(t);
  const inv = await invoice(DB, "cus_acme", "2026-09");
  const env = {
    DB,
    PAYMENT_WORKFLOW: workflow(),
    PAYMENT_PROCESSOR: processor(scenarios),
    PROCESSOR_TOKEN: "test",
    PROCESSOR_WEBHOOK_SECRET: "test"
  };
  const owner = await claimCollection(DB, inv.id, 0);
  return { env, owner, inv };
}

test("PaymentWorkflow lost response retries immutable payload and posts once", async (t) => {
  const { env, owner } = await setup(t, ["lost"]);
  const result = await runPaymentCollection(env, owner, steps(t));
  assert.equal(result.status, "paid");
  assert.equal(result.attemptsUsed, 1);
  assert.equal(env.PAYMENT_PROCESSOR.posts, 2);
  assert.deepEqual(
    env.PAYMENT_PROCESSOR.requests[0],
    env.PAYMENT_PROCESSOR.requests[1]
  );
  // The lost response and same-key replay are visible, not hidden behind "paid".
  const { timeline } = await getPaymentCollection(env.DB, owner.invoiceId);
  const transport = timeline.filter((e) => e.kind.startsWith("charge_"));
  assert.deepEqual(
    transport.map((e) => e.kind),
    ["charge_unanswered", "charge_replayed"]
  );
  assert.match(transport[0].message, /HTTP 504/);
  assert.equal(
    (await env.DB.prepare("SELECT COUNT(*) AS n FROM payments").first()).n,
    1
  );
  assert.equal(
    (
      await env.DB.prepare(
        "SELECT SUM(amount_cents) AS balance FROM ledger_entries"
      ).first()
    ).balance,
    0
  );
});

test("PaymentWorkflow retry exhaustion reaches three original-key lookups; unknown retains its only reservation", async (t) => {
  const { env, owner } = await setup(t, ["unavailable"]);
  const step = steps(t);
  const result = await runPaymentCollection(env, owner, step);
  assert.equal(result.status, "needs_review");
  assert.equal(env.PAYMENT_PROCESSOR.posts, 3);
  assert.equal(env.PAYMENT_PROCESSOR.lookups, 3);
  assert.ok(
    env.PAYMENT_PROCESSOR.requests.every(
      (p) =>
        p.idempotencyKey === env.PAYMENT_PROCESSOR.requests[0].idempotencyKey
    )
  );
  const state = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(state.reservedCents, state.totalCents);
  assert.equal(state.attemptsUsed, 1);
  assert.equal(step.calls.filter((c) => c[0] === "waitForEvent").length, 2);
  // A new generation recovers the original unknown by status only, not charge replay.
  const next = await claimCollection(env.DB, owner.invoiceId, owner.generation);
  await runPaymentCollection(env, next, steps(t));
  assert.equal(env.PAYMENT_PROCESSOR.posts, 3);
  assert.equal(
    (await getPaymentCollection(env.DB, owner.invoiceId)).attemptsUsed,
    1
  );
});

test("PaymentWorkflow four soft declines share the lifetime budget and three durable dunning slots", async (t) => {
  const { env, owner } = await setup(t, ["soft"]);
  const step = steps(t);
  const result = await runPaymentCollection(env, owner, step);
  assert.equal(result.status, "past_due");
  assert.equal(result.attemptsUsed, 4);
  assert.equal(env.PAYMENT_PROCESSOR.posts, 4);
  assert.equal(step.calls.filter((c) => c[0] === "sleepUntil").length, 3);
  const detail = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(
    detail.timeline.filter((n) => n.kind === "retry_scheduled").length,
    3
  );
  const next = await claimCollection(env.DB, owner.invoiceId, owner.generation);
  await runPaymentCollection(env, next, steps(t));
  assert.equal(env.PAYMENT_PROCESSOR.posts, 4);
});

test("PaymentWorkflow manual retry after four soft declines charges once at once, then stops again", async (t) => {
  const { env, owner } = await setup(t, [
    "soft",
    "soft",
    "soft",
    "soft",
    "soft",
    "success"
  ]);
  await runPaymentCollection(env, owner, steps(t));
  const run = async () => {
    const started = await retryCollection(env, owner.invoiceId);
    assert.equal(started.started, true);
    const step = steps(t);
    const result = await runPaymentCollection(
      env,
      env.PAYMENT_WORKFLOW.instances.get(started.id).params,
      step
    );
    // A manual attempt skips the dunning wait
    assert.equal(step.calls.filter((c) => c[0] === "sleepUntil").length, 0);
    return result;
  };
  assert.deepEqual(Object.values(await run()).slice(1), ["past_due", 5]);
  assert.equal(env.PAYMENT_PROCESSOR.posts, 5);
  assert.deepEqual(Object.values(await run()).slice(1), ["paid", 6]);
  assert.equal(env.PAYMENT_PROCESSOR.posts, 6);
  const c = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.deepEqual([c.attemptLimit, c.attemptsRemaining], [6, 0]);
  assert.deepEqual(
    c.timeline
      .filter((e) => e.kind === "manual_retry")
      .map((e) => e.attemptNumber),
    [4, 5]
  );
  assert.equal(
    c.timeline.filter((e) => e.kind === "retry_scheduled").length,
    3,
    "only the automatic attempts were dunned"
  );
});

test("PaymentWorkflow ends paid when a decline turns into a late success during the card wait", async (t) => {
  const { env, owner } = await setup(t, ["hard"]);
  const result = await runPaymentCollection(
    env,
    owner,
    steps(t, async () => {
      const [charge] = env.PAYMENT_PROCESSOR.charges.values();
      const { declineType, ...rest } = charge;
      assert.equal(declineType, "hard");
      await applyPaymentOutcome(env.DB, { ...rest, status: "succeeded" });
    })
  );
  assert.equal(result.status, "paid");
  assert.equal(result.attemptsUsed, 1);
  assert.equal(env.PAYMENT_PROCESSOR.posts, 1, "no second charge");
  const c = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.deepEqual([c.paidCents, c.reservedCents], [c.totalCents, 0]);
});

test("PaymentWorkflow repeated hard declines require newer methods and still stop at four", async (t) => {
  const { env, owner } = await setup(t, ["hard"]);
  await runPaymentCollection(
    env,
    owner,
    steps(t, async (options) => {
      assert.equal(options.type, "payment-method-updated");
      const c = await getPaymentCollection(env.DB, owner.invoiceId);
      await updatePaymentMethod(env.DB, c.customerId, c.methodVersion);
    })
  );
  const c = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(c.status, "past_due");
  assert.deepEqual(
    c.attempts.map((a) => a.methodVersion),
    [1, 2, 3, 4]
  );
});

test("PaymentWorkflow full credit during card wait settles rather than past due", async (t) => {
  const { env, owner, inv } = await setup(t, ["hard"]);
  await runPaymentCollection(
    env,
    owner,
    steps(t, async () => {
      await issueCredit(env.DB, {
        id: "wait-credit",
        invoiceId: inv.id,
        amountCents: inv.totalCents,
        reason: "approved",
        approvedBy: "test"
      });
    })
  );
  const c = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(c.status, "settled");
  assert.equal(c.attemptsUsed, 1);
});

test("PaymentWorkflow card timeout cannot authorize a fresh key, including a resumed generation", async (t) => {
  const { env, owner } = await setup(t, ["hard"]);
  await runPaymentCollection(env, owner, steps(t));
  const next = await claimCollection(env.DB, owner.invoiceId, owner.generation);
  await runPaymentCollection(env, next, steps(t));
  assert.equal(env.PAYMENT_PROCESSOR.posts, 1);
  assert.equal(
    (await getPaymentCollection(env.DB, owner.invoiceId)).status,
    "past_due"
  );
});

test("PaymentWorkflow resumes a pre-call reservation without allocating another attempt", async (t) => {
  const { env, owner } = await setup(t, ["success"]);
  const before = await preparePaymentAttempt(env.DB, owner);
  await runPaymentCollection(env, owner, steps(t));
  assert.deepEqual(
    env.PAYMENT_PROCESSOR.requests[0],
    chargePayload(before.attempt)
  );
  assert.equal(
    (await getPaymentCollection(env.DB, owner.invoiceId)).attemptsUsed,
    1
  );
});

test("startCollection parallel calls and lost create acknowledgment recover the persisted Workflow ID", async (t) => {
  const { env, owner } = await setup(t, ["success"]);
  const create = env.PAYMENT_WORKFLOW.create.bind(env.PAYMENT_WORKFLOW);
  env.PAYMENT_WORKFLOW.create = async (params) => {
    await create(params);
    throw new Error("lost response");
  };
  const results = await Promise.all(
    Array.from({ length: 3 }, () => startCollection(env, owner.invoiceId))
  );
  assert.deepEqual(
    new Set(results.map((r) => r.id)),
    new Set([owner.workflowId])
  );
  assert.equal(env.PAYMENT_WORKFLOW.instances.size, 1);
  assert.equal(
    (await getPaymentCollection(env.DB, owner.invoiceId)).generation,
    1
  );
});

test("PaymentWorkflow does not POST when processor key retention is expired or unproven", async (t) => {
  const { env, owner } = await setup(t, ["success"]);
  const prepared = await preparePaymentAttempt(env.DB, owner);
  let posts = 0,
    checks = 0;
  env.PAYMENT_PROCESSOR = {
    async fetch(request) {
      if (request.method === "POST") posts++;
      if (new URL(request.url).pathname === "/demo/inspect")
        return Response.json({ keyRetention: "expired" });
      assert.equal(
        new URL(request.url).searchParams.get("idempotencyKey"),
        prepared.attempt.idempotencyKey
      );
      checks++;
      return new Response(null, { status: 404 });
    }
  };
  assert.equal(
    (await runPaymentCollection(env, owner, steps(t))).status,
    "needs_review"
  );
  assert.equal(posts, 0);
  assert.equal(checks, 3);
  const c = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(c.attemptsUsed, 1);
  assert.equal(c.reservedCents, c.totalCents);
});

test("PaymentWorkflow stale card hints use fixed deadline and bounded sleep polls, never another key", async (t) => {
  const { env, owner } = await setup(t, ["hard"]);
  const step = steps(t);
  step.waitForEvent = async () => ({
    type: "payment-method-updated",
    payload: { version: 999 }
  });
  assert.equal(
    (await runPaymentCollection(env, owner, step)).status,
    "past_due"
  );
  assert.equal(env.PAYMENT_PROCESSOR.posts, 1);
  assert.equal(step.calls.filter((c) => c[0] === "sleep").length, 6);
  const c = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(
    c.timeline.filter((n) => n.kind === "card_update_requested").length,
    1
  );
});

test("startCollection recovers an ended generation without resetting its unresolved attempt", async (t) => {
  const { env, owner } = await setup(t, ["success"]);
  const before = await preparePaymentAttempt(env.DB, owner);
  await env.PAYMENT_WORKFLOW.create({ id: owner.workflowId, params: owner });
  env.PAYMENT_WORKFLOW.instances.get(owner.workflowId).status = async () => ({
    status: "errored"
  });
  const resumed = await startCollection(env, owner.invoiceId);
  assert.notEqual(resumed.id, owner.workflowId);
  assert.equal(resumed.collection.generation, 2);
  assert.deepEqual(resumed.collection.attempts, [before.attempt]);
  assert.equal(resumed.collection.attemptsUsed, 1);
  assert.equal(resumed.collection.reservedCents, before.attempt.amountCents);
});

test("PaymentWorkflow pending timeouts skip elapsed sleeps, preserve three checks and reservation", async (t) => {
  const { env, owner } = await setup(t, ["pending"]);
  const step = steps(t);
  const result = await runPaymentCollection(env, owner, step);
  assert.equal(result.status, "needs_review");
  assert.equal(env.PAYMENT_PROCESSOR.lookups, 3);
  assert.equal(step.calls.filter((c) => c[0] === "waitForEvent").length, 3);
  assert.equal(step.calls.filter((c) => c[0] === "sleepUntil").length, 0);
  const detail = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(detail.reservedCents, detail.totalCents);
  assert.equal(detail.attemptsUsed, 1);
});

test("PaymentWorkflow replay of elapsed dunning notice does not sleep in the past or extend its deadline", async (t) => {
  const { env, owner } = await setup(t, ["success"]);
  const { attempt } = await preparePaymentAttempt(env.DB, owner);
  await applyPaymentOutcome(env.DB, {
    ...chargePayload(attempt),
    processorPaymentId: "previous-soft",
    status: "declined",
    declineType: "soft"
  });
  const deadlineAt = new Date(Date.now() - 60_000).toISOString();
  await recordCollectionNotice(env.DB, owner, {
    id: `${attempt.id}:retry`,
    attemptNumber: 1,
    kind: "retry_scheduled",
    message: "Dunning retry slot 1 (day 1 in production).",
    deadlineAt
  });
  const step = steps(t);
  assert.equal((await runPaymentCollection(env, owner, step)).status, "paid");
  assert.equal(step.calls.filter((c) => c[0] === "sleepUntil").length, 0);
  const detail = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(detail.attemptsUsed, 2);
  assert.equal(
    detail.timeline.find((e) => e.kind === "retry_scheduled").deadlineAt,
    deadlineAt
  );
});

for (const declineType of ["soft", "hard"]) {
  for (const boundary of ["after-state", "before-batch", "after-batch"]) {
    test(`PaymentWorkflow reevaluates ${declineType} decline at ${boundary} without bypassing its gate`, async (t) => {
      const { env, owner } = await setup(t, ["success"]);
      const db = env.DB;
      const { attempt } = await preparePaymentAttempt(db, owner);
      let injected = false;
      let preparing = false;
      const inject = async () => {
        injected = true;
        await applyPaymentOutcome(db, {
          ...chargePayload(attempt),
          processorPaymentId: "concurrent-decline",
          status: "declined",
          declineType
        });
      };
      const step = steps(t, async (options) => {
        assert.equal(declineType, "hard");
        assert.equal(options.type, "payment-method-updated");
        const state = await getPaymentCollection(db, owner.invoiceId);
        assert.ok(
          state.timeline.some((e) => e.kind === "card_update_requested")
        );
        assert.equal(
          state.status,
          "action_required",
          "must request and wait before past_due"
        );
      });
      env.DB = {
        prepare: db.prepare.bind(db),
        async batch(statements) {
          if (preparing && !injected && boundary === "before-batch")
            await inject();
          const result = await db.batch(statements);
          if (preparing && !injected && boundary === "after-batch")
            await inject();
          return result;
        }
      };
      const execute = step.do.bind(step);
      let firstPreparation;
      step.do = async (name, config, fn) => {
        preparing = name === "turn-0-prepare";
        const result = await execute(name, config, fn);
        preparing = false;
        if (name === "turn-0-state" && boundary === "after-state")
          await inject();
        if (name === "turn-0-prepare") firstPreparation = result;
        return result;
      };
      const fetch = env.PAYMENT_PROCESSOR.fetch.bind(env.PAYMENT_PROCESSOR);
      env.PAYMENT_PROCESSOR.fetch = async (request) => {
        if (request.method === "POST") {
          assert.equal(
            declineType,
            "soft",
            "hard decline cannot charge without newer method"
          );
          const state = await getPaymentCollection(db, owner.invoiceId);
          const notice = state.timeline.find(
            (e) => e.kind === "retry_scheduled"
          );
          assert.ok(notice, "dunning must be recorded before any new POST");
          assert.ok(
            Date.now() >= Date.parse(notice.deadlineAt),
            "dunning deadline must be observed before POST"
          );
          assert.ok(step.calls.some((c) => c[0] === "sleepUntil"));
        }
        return fetch(request);
      };
      const result = await runPaymentCollection(env, owner, step);
      assert.equal(injected, true);
      assert.equal(
        firstPreparation.kind,
        boundary === "after-batch" ? "attempt" : "reevaluate"
      );
      if (boundary === "after-batch") {
        assert.equal(
          firstPreparation.attempt.state,
          "prepared",
          "return the atomic batch snapshot, not a racing second read"
        );
        assert.equal(firstPreparation.created, false);
      }
      const detail = await getPaymentCollection(db, owner.invoiceId);
      if (declineType === "soft") {
        assert.equal(result.status, "paid");
        assert.equal(result.attemptsUsed, 2);
        assert.equal(env.PAYMENT_PROCESSOR.posts, 1);
        assert.equal(
          env.PAYMENT_PROCESSOR.requests[0].attemptId,
          detail.attempts[1].id
        );
        assert.equal(step.calls.filter((c) => c[0] === "sleepUntil").length, 1);
      } else {
        assert.equal(result.status, "past_due");
        assert.equal(result.attemptsUsed, 1);
        assert.equal(env.PAYMENT_PROCESSOR.posts, 0);
        assert.equal(
          step.calls.filter((c) => c[0] === "waitForEvent").length,
          1
        );
        const notice = detail.timeline.find(
          (e) => e.kind === "card_update_requested"
        );
        assert.ok(Date.now() >= Date.parse(notice.deadlineAt));
      }
    });
  }
}

/** Successful checkpoints are serialized and cached across invocations, like Workflows.
 * Interruptions happen outside the callback/retry loop, not as a fake business outcome.
 */
function checkpointSteps(t, onWait) {
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const stored = new Map();
  const calls = [];
  let interruption;
  const cached = async (kind, name, callback) => {
    if (name === interruption) {
      interruption = undefined;
      throw new Error("simulated Workflow interruption");
    }
    const key = `${kind}:${name}`;
    calls.push([kind, name, stored.has(key)]);
    if (!stored.has(key)) stored.set(key, structuredClone(await callback()));
    return structuredClone(stored.get(key));
  };
  return {
    calls,
    stored,
    interruptBefore(name) {
      interruption = name;
    },
    advance(ms) {
      clock += ms;
    },
    do(name, config, fn) {
      return cached("do", name, async () => {
        let error;
        for (let retry = 0; retry <= config.retries.limit; retry++) {
          try {
            return await fn();
          } catch (failure) {
            error = failure;
          }
        }
        throw error;
      });
    },
    sleep(name, ms) {
      return cached("sleep", name, async () => {
        clock += ms;
      });
    },
    sleepUntil(name, date) {
      return cached("sleepUntil", name, async () => {
        assert.ok(Number(date) > clock);
        clock = Number(date);
      });
    },
    waitForEvent(name, options) {
      return cached("waitForEvent", name, async () => {
        await onWait(options);
        clock += 1000;
        return { type: options.type, payload: { version: 2 } };
      });
    }
  };
}

for (const interruption of ["after-card-event", "card-decision", "prepare"]) {
  test(`PaymentWorkflow checkpoint replay after deadline preserves card update when interrupted before ${interruption}`, async (t) => {
    const { env, owner } = await setup(t, ["hard", "success"]);
    const step = checkpointSteps(t, async (options) => {
      assert.equal(options.type, "payment-method-updated");
      await updatePaymentMethod(env.DB, "cus_acme", 1);
    });
    step.interruptBefore(`turn-1-${interruption}`);
    await assert.rejects(
      runPaymentCollection(env, owner, step),
      /simulated Workflow interruption/
    );
    assert.equal(
      step.stored.get("do:turn-1-before-card-wait").methodVersion,
      1
    );
    if (interruption === "prepare")
      assert.equal(step.stored.get("do:turn-1-card-decision").methodVersion, 2);
    const before = await getPaymentCollection(env.DB, owner.invoiceId);
    assert.equal(before.methodVersion, 2);
    assert.equal(before.attemptsUsed, 1);
    const deadline = before.timeline.find(
      (e) => e.kind === "card_update_requested"
    ).deadlineAt;
    step.advance(60_000);
    assert.ok(Date.now() > Date.parse(deadline));
    const result = await runPaymentCollection(env, owner, step);
    assert.equal(result.status, "paid");
    const after = await getPaymentCollection(env.DB, owner.invoiceId);
    assert.deepEqual(
      after.attempts.map((a) => a.methodVersion),
      [1, 2]
    );
    assert.equal(env.PAYMENT_PROCESSOR.posts, 2);
    assert.equal(
      after.timeline.find((e) => e.kind === "card_update_requested").deadlineAt,
      deadline
    );
    assert.equal(
      after.timeline.filter((e) => e.kind === "card_update_requested").length,
      1
    );
    assert.equal(
      step.calls.filter((c) => c[0] === "waitForEvent").length,
      1,
      "elapsed replay skips waiting, never its decision checkpoint"
    );
    assert.ok(
      step.calls.some((c) => c[0] === "do" && c[1] === "turn-0-state" && c[2]),
      "fixture really replays cached snapshots"
    );
  });
}

test("PaymentWorkflow reevaluation allowance does not consume the four-attempt progress budget", async (t) => {
  const { env, owner } = await setup(t, ["soft"]);
  const step = steps(t);
  const execute = step.do.bind(step);
  let changed = 0;
  step.do = (name, config, fn) =>
    execute(
      name,
      config,
      name.endsWith("-prepare") && changed++ < 8
        ? async () => ({
            kind: "reevaluate",
            collection: await getPaymentCollection(env.DB, owner.invoiceId)
          })
        : fn
    );
  const result = await runPaymentCollection(env, owner, step);
  assert.equal(result.status, "past_due");
  assert.equal(result.attemptsUsed, 4);
  assert.equal(env.PAYMENT_PROCESSOR.posts, 4);
  assert.equal(step.calls.filter((c) => c[0] === "sleepUntil").length, 3);
  assert.equal(
    (await getPaymentCollection(env.DB, owner.invoiceId)).ownerActive,
    0
  );
});

test("PaymentWorkflow excessive reevaluation fails explicitly without releasing unfinished ownership", async (t) => {
  const { env, owner } = await setup(t, ["success"]);
  const step = steps(t);
  const execute = step.do.bind(step);
  step.do = (name, config, fn) =>
    execute(
      name,
      config,
      name.endsWith("-prepare")
        ? async () => ({
            kind: "reevaluate",
            collection: await getPaymentCollection(env.DB, owner.invoiceId)
          })
        : fn
    );
  await assert.rejects(
    runPaymentCollection(env, owner, step),
    /preparation kept changing; reconcile and resume/
  );
  assert.equal(
    step.calls.filter((c) => c[0] === "do" && c[1].endsWith("-prepare")).length,
    9
  );
  assert.ok(!step.calls.some((c) => c[1] === "release-collection-owner"));
  const state = await getPaymentCollection(env.DB, owner.invoiceId);
  assert.equal(state.ownerActive, 1);
  assert.equal(state.attemptsUsed, 0);
  assert.equal(state.status, "open");
  assert.equal(env.PAYMENT_PROCESSOR.posts, 0);
});
