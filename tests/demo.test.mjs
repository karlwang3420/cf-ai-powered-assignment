// Hosted demo: Access token checks, when a new reviewer reseeds the shared
// demo, and the reset itself against a real (in-memory) D1 database.
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, readFileSync } from "node:fs";
import { handleApi } from "../src/api.ts";
import { issueCredit } from "../src/billing/store.ts";
import {
  applyPaymentOutcome,
  claimCollection,
  getPaymentCollection,
  preparePaymentAttempt
} from "../src/billing/payments.ts";
import { accessSession, verifyAccessJwt } from "../src/demo/access.ts";
import { rebuildDatabase } from "../src/demo/database.ts";
import { admitDemoRequest } from "../src/demo/gate.ts";
import { refuseCrossSite } from "../src/origin.ts";
import { deploySteps } from "../scripts/deploy-demo.mjs";
import {
  PROCESSOR_CALLBACK_ORIGIN,
  PROCESSOR_WEBHOOK_PATH
} from "../src/payments/protocol.ts";
import { resetDemo } from "../src/demo/reset.ts";
import {
  admitSession,
  emptyDemoState,
  IDLE_MS,
  resetSession
} from "../src/demo/session.ts";
import { NOW, database, invoice } from "./helpers/d1.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");

/** The files src/demo/sql.ts bundles, in order. */
const bundled = [
  ...read("src/demo/sql.ts").matchAll(/"\.\.\/\.\.\/(.+)\?raw"/g)
].map((m) => m[1]);
const scripts = () => bundled.map(read);

/** Every row of every table and view, so two databases can be compared. */
async function dump(db) {
  const { results } = await db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name <> 'd1_migrations' ORDER BY type, name"
    )
    .all();
  const rows = {};
  for (const { type, name } of results)
    if (type === "table" || type === "view")
      rows[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results
        .map((row) => JSON.stringify(row))
        .sort();
  return { schema: results, rows };
}

async function paidInvoice(db) {
  const { id } = await invoice(db, "cus_acme", "2026-09");
  const owner = await claimCollection(db, id, 0, NOW);
  const prepared = await preparePaymentAttempt(db, owner, NOW, null);
  const attempt = prepared.attempt;
  await applyPaymentOutcome(
    db,
    {
      invoiceId: attempt.invoiceId,
      attemptId: attempt.id,
      idempotencyKey: attempt.idempotencyKey,
      amountCents: attempt.amountCents,
      currency: attempt.currency,
      methodVersion: attempt.methodVersion,
      processorPaymentId: `processor:${attempt.id}`,
      status: "succeeded"
    },
    { now: NOW }
  );
  assert.equal((await getPaymentCollection(db, id)).status, "paid");
  return id;
}

test("the bundled reset SQL is every migration, in order, then the seed", () => {
  const migrations = readdirSync(new URL("migrations/", root))
    .sort()
    .map((name) => `migrations/${name}`);
  assert.deepEqual(bundled, [...migrations, "seed/demo.sql"]);
});

test("rebuild returns a used database, immutable payments included, to the seed", async (t) => {
  const fresh = await database(t);
  const used = await database(t);
  await paidInvoice(used);
  const { id } = await invoice(used, "cus_nimbus", "2026-09");
  await issueCredit(
    used,
    {
      id: "credit",
      invoiceId: id,
      amountCents: 500,
      reason: "service credit",
      approvedBy: "operator"
    },
    NOW
  );
  await assert.rejects(
    used.prepare("DELETE FROM ledger_entries").run(),
    /immutable/,
    "rows cannot simply be deleted"
  );

  await rebuildDatabase(used, scripts());
  assert.deepEqual(await dump(used), await dump(fresh));
  // Rebuilding twice is harmless, and the triggers are back in force
  await rebuildDatabase(used, scripts());
  assert.deepEqual(await dump(used), await dump(fresh));
  await paidInvoice(used);
  await assert.rejects(used.prepare("DELETE FROM payments").run(), /immutable/);
});

test("rebuild seeds an empty database (the first hosted request)", async (t) => {
  const fresh = await database(t);
  const empty = await database(t, { seed: false, through: "" });
  await rebuildDatabase(empty, scripts());
  assert.deepEqual(await dump(empty), await dump(fresh));
});

test("a new session reseeds only an idle demo; a returning one keeps its data", () => {
  const exp = 10 * IDLE_MS;
  let s = emptyDemoState();
  let r = admitSession(s, "alice:1", exp, 0);
  assert.equal(r.reset, true, "the first request seeds the database");
  assert.equal(r.status.lastResetAt, new Date(0).toISOString());
  s = r.state;

  r = admitSession(s, "alice:1", exp, 1000);
  assert.equal(r.reset, false);
  assert.equal(r.status.othersActive, false);
  s = r.state;

  r = admitSession(s, "bob:1", exp, IDLE_MS);
  assert.equal(r.reset, false, "Alice was active less than 15 minutes ago");
  assert.equal(r.status.othersActive, true);
  s = r.state;

  r = admitSession(s, "alice:1", exp, IDLE_MS + 1000);
  assert.equal(r.status.othersActive, true, "Bob is active too");
  s = r.state;

  const later = IDLE_MS * 3;
  r = admitSession(s, "alice:1", exp, later);
  assert.equal(r.reset, false, "a returning session keeps its data");
  assert.equal(r.status.othersActive, false, "Bob has gone quiet");
  s = r.state;

  r = admitSession(s, "carol:1", exp, later + IDLE_MS);
  assert.equal(r.reset, true, "a new reviewer after 15 idle minutes");
  assert.equal(r.status.othersActive, false);
  s = r.state;

  r = admitSession(s, "carol:1", exp, exp + IDLE_MS);
  assert.equal(r.reset, true, "an expired Access session counts as new");
  assert.deepEqual(Object.keys(r.state.sessions), ["carol:1"]);

  const busy = admitSession(r.state, "carol:1", exp, exp + IDLE_MS + 1);
  assert.equal(busy.reset, false);
  assert.equal(
    admitSession(r.state, "carol:1", exp, exp + IDLE_MS + 1, true).reset,
    true,
    "an unfinished reset is retried even mid-session"
  );

  const manual = resetSession(r.state, exp + IDLE_MS + 5);
  assert.equal(manual.status.reset, true);
  assert.deepEqual(Object.keys(manual.state.sessions), ["carol:1"]);
});

// Access tokens: RS256 signed by the team's published key
const TEAM = "reviewers.cloudflareaccess.com";
const AUD = "aud-tag";
const keys = await crypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256"
  },
  true,
  ["sign", "verify"]
);
const jwk = {
  ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
  kid: "k1"
};
const b64 = (value) =>
  Buffer.from(
    typeof value === "string" ? value : JSON.stringify(value)
  ).toString("base64url");
async function token(claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", kid: "k1", ...header })}.${b64({
    aud: [AUD],
    iss: `https://${TEAM}`,
    sub: "user-1",
    email: "reviewer@cloudflare.com",
    iat: now,
    exp: now + 3600,
    ...claims
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(body)
  );
  return `${body}.${Buffer.from(signature).toString("base64url")}`;
}
function certs() {
  const calls = [];
  const fetcher = async (url) => {
    calls.push(url);
    return Response.json({ keys: [jwk] });
  };
  return { calls, fetcher };
}

test("Access tokens must be signed by the team, for this app, and unexpired", async () => {
  // Each case uses its own team domain so the key cache cannot hide a fetch
  let n = 0;
  const check = async (value, teamDomain = `t${++n}.${TEAM}`) => {
    const { fetcher } = certs();
    const claims = typeof value === "function" ? value(teamDomain) : value;
    return verifyAccessJwt(await claims, {
      teamDomain,
      aud: AUD,
      fetcher
    });
  };
  const forTeam = (claims) => (team) =>
    token({ iss: `https://${team}`, ...claims });

  const ok = await check(forTeam({}));
  assert.equal(ok.email, "reviewer@cloudflare.com");
  assert.equal(accessSession(ok), `user-1:${ok.iat}`);
  assert.equal(await check(forTeam({ aud: ["other-app"] })), null);
  assert.equal(
    await check(forTeam({ exp: Math.floor(Date.now() / 1000) - 1 })),
    null
  );
  assert.equal(await check(token()), null, "issued by another team");
  const forged = (await token({ iss: `https://${TEAM}` })).replace(
    /\.[^.]+$/,
    `.${b64("not a signature")}`
  );
  assert.equal(await check(forged, TEAM), null);
  const none = async (team) =>
    (await token({ iss: `https://${team}` }, { alg: "none" })).replace(
      /[^.]+$/,
      ""
    );
  assert.equal(await check(none), null);
  assert.equal(await check("not.a.jwt"), null);
});

test("Access signing keys are cached and refreshed once for an unknown key ID", async () => {
  const teamDomain = `cache.${TEAM}`;
  const iss = `https://${teamDomain}`;
  const { calls, fetcher } = certs();
  const options = { teamDomain, aud: AUD, fetcher };
  assert.ok(await verifyAccessJwt(await token({ iss }), options));
  assert.ok(await verifyAccessJwt(await token({ iss }), options));
  assert.equal(calls.length, 1, "cached");
  assert.equal(calls[0], `${iss}/cdn-cgi/access/certs`);
  assert.equal(
    await verifyAccessJwt(await token({ iss }, { kid: "rotated" }), options),
    null
  );
  assert.equal(calls.length, 2, "one refresh for a rotated key");
});

function demoEnv(overrides = {}) {
  const admitted = [];
  return {
    admitted,
    DEMO_ACCESS_TEAM_DOMAIN: TEAM,
    DEMO_ACCESS_AUD: AUD,
    DEMO_SESSION: {
      getByName: (name) => ({
        admit: async (session, expires) => {
          admitted.push({ name, session, expires });
          return { enabled: true, reset: false };
        }
      })
    },
    ...overrides
  };
}
const request = (path, init = {}) =>
  new Request(`https://demo.example${path}`, init);
const callback = () =>
  new Request(`${PROCESSOR_CALLBACK_ORIGIN}${PROCESSOR_WEBHOOK_PATH}`, {
    method: "POST"
  });

test("hosted demo requests need a valid Access token; local dev is unaffected", async () => {
  const verify = async (value) =>
    value === "good" ? { sub: "user-1", iat: 100, exp: 200 } : null;
  const withToken = (path, value, init = {}) =>
    request(path, {
      ...init,
      headers: { "Cf-Access-Jwt-Assertion": value }
    });

  const local = demoEnv({ DEMO_ACCESS_TEAM_DOMAIN: "", DEMO_ACCESS_AUD: "" });
  for (const host of ["localhost:5173", "127.0.0.1:5173", "[::1]:5173"])
    assert.equal(
      await admitDemoRequest(
        new Request(`http://${host}/api/customers`),
        local,
        verify
      ),
      null
    );
  assert.equal(
    (await admitDemoRequest(request("/api/customers"), local, verify)).status,
    503,
    "deployed without Access settings fails closed"
  );
  assert.equal(await admitDemoRequest(request("/"), local, verify), null);
  assert.equal(
    await admitDemoRequest(callback(), local, verify),
    null,
    "local dev receives the processor callback"
  );

  const env = demoEnv();
  assert.equal(await admitDemoRequest(request("/"), env, verify), null);
  assert.equal(
    (await admitDemoRequest(request("/api/customers"), env, verify)).status,
    403
  );
  assert.equal(
    (await admitDemoRequest(withToken("/agents/x", "forged"), env, verify))
      .status,
    403
  );
  assert.equal(
    await admitDemoRequest(callback(), env, verify),
    null,
    "the processor's signed callback arrives over the service binding"
  );
  assert.equal(
    (
      await admitDemoRequest(
        request("/api/payments/webhook", { method: "POST" }),
        env,
        verify
      )
    ).status,
    403,
    "the same path from the Internet needs Access"
  );
  assert.equal(
    (
      await admitDemoRequest(
        new Request("https://merchant.internal/api/payments/webhook"),
        env,
        verify
      )
    ).status,
    403,
    "only the exact callback is exempt"
  );
  assert.deepEqual(
    await admitDemoRequest(withToken("/api/customers", "good"), env, verify),
    { enabled: true, reset: false }
  );
  assert.deepEqual(env.admitted, [
    { name: "demo", session: "user-1:100", expires: 200_000 }
  ]);

  const half = demoEnv({ DEMO_ACCESS_AUD: "" });
  assert.equal(
    (await admitDemoRequest(withToken("/api/customers", "good"), half, verify))
      .status,
    503,
    "half-configured fails closed"
  );
  const failing = async () => {
    throw new Error("certs unavailable");
  };
  assert.equal(
    (await admitDemoRequest(withToken("/api/customers", "good"), env, failing))
      .status,
    503
  );
});

test("the API and chat agents refuse cross-site browser requests, locally and hosted", () => {
  const agent = (
    headers,
    url = "http://localhost:5173/agents/billing-assistant/cus_acme"
  ) => refuseCrossSite(new Request(url, { headers }));
  assert.equal(agent({}), null, "CLI and tests send no Origin");
  assert.equal(
    agent({ Origin: "http://localhost:5173", Upgrade: "websocket" }),
    null
  );
  assert.equal(
    agent({ Origin: "https://evil.example", Upgrade: "websocket" }).status,
    403
  );
  assert.equal(agent({ "Sec-Fetch-Site": "cross-site" }).status, 403);
  assert.equal(agent({ "Sec-Fetch-Site": "same-origin" }), null);
  assert.equal(
    agent(
      { Origin: "https://evil.example" },
      "http://localhost:5173/api/customers"
    ).status,
    403,
    "cross-site reads would otherwise keep the shared demo active"
  );
  assert.equal(
    agent(
      { Origin: "http://localhost:5173" },
      "http://localhost:5173/api/customers"
    ),
    null
  );
  assert.equal(
    agent({ Origin: "https://evil.example" }, "http://localhost:5173/"),
    null,
    "the page itself is static assets"
  );
});

test("deploys put the processor up before the app that binds to it", () => {
  assert.deepEqual(deploySteps(true), ["processor", "main"]);
  assert.deepEqual(deploySteps(false), [
    "processor-bootstrap",
    "main",
    "processor"
  ]);
});

test("the demo API reports status and resets only in hosted demo mode", async (t) => {
  const db = await database(t);
  const resets = [];
  const env = {
    DB: db,
    DEMO_SESSION: {
      getByName: () => ({
        reset: async () => {
          resets.push(1);
          return { enabled: true, reset: true };
        }
      })
    }
  };
  const status = { enabled: true, reset: false, othersActive: true };
  const call = (path, init, demo = status) =>
    handleApi(request(path, init), env, NOW, demo);

  assert.deepEqual(await (await call("/api/demo", {}, null)).json(), {
    enabled: false
  });
  assert.deepEqual(await (await call("/api/demo")).json(), status);
  assert.equal(
    (await call("/api/demo/reset", { method: "POST" }, null)).status,
    404,
    "local dev has no demo reset"
  );
  assert.equal(
    (
      await call("/api/demo/reset", {
        method: "POST",
        headers: { Origin: "https://evil.example" }
      })
    ).status,
    403
  );
  assert.equal((await call("/api/demo/other", { method: "POST" })).status, 404);
  assert.deepEqual(resets, []);
  const reset = await call("/api/demo/reset", { method: "POST" });
  assert.deepEqual(await reset.json(), { enabled: true, reset: true });
  assert.deepEqual(resets, [1]);

  // When admitting this request already reset the demo, do not reset again
  const admittedReset = { ...status, reset: true };
  const once = await call("/api/demo/reset", { method: "POST" }, admittedReset);
  assert.deepEqual(await once.json(), admittedReset);
  assert.deepEqual(resets, [1]);
});

/** Runs named `ended`, `running`, `missing` and `flaky` fail as their name says. */
function resetEnv(db, processorStatus = 200) {
  const calls = { terminated: [], processor: [] };
  return {
    calls,
    DB: db,
    PROCESSOR_TOKEN: "token",
    PAYMENT_WORKFLOW: {
      get: async (id) => {
        if (id === "missing") throw new Error("instance.not_found");
        if (id === "flaky") throw new Error("Workflows API unavailable");
        return {
          terminate: async () => {
            calls.terminated.push(id);
            if (id === "ended" || id === "running")
              throw new Error("cannot terminate");
          },
          status: async () => ({
            status: id === "running" ? "running" : "complete"
          })
        };
      }
    },
    PAYMENT_PROCESSOR: {
      fetch: async (req) => {
        calls.processor.push(`${req.method} ${new URL(req.url).pathname}`);
        return Response.json({}, { status: processorStatus });
      }
    }
  };
}

test("demo reset stops runs and clears the processor before rebuilding D1 and chats", async (t) => {
  const fresh = await database(t);
  const db = await database(t);
  const id = await paidInvoice(db);
  await db
    .prepare(
      "UPDATE payment_collections SET owner_active = 1, owner_id = 'o', workflow_id = 'run-1' WHERE invoice_id = ?"
    )
    .bind(id)
    .run();

  const failing = resetEnv(db, 503);
  await assert.rejects(
    resetDemo(failing, scripts(), async () => {}),
    /processor reset failed/
  );
  assert.equal(
    (await getPaymentCollection(db, id)).status,
    "paid",
    "a processor failure leaves D1 untouched"
  );

  // A chat that cannot be cleared fails the reset so it is retried, after
  // every other chat has been tried
  const env = resetEnv(db);
  const cleared = [];
  await assert.rejects(
    resetDemo(env, scripts(), async (customerId) => {
      cleared.push(customerId);
      if (customerId === "cus_orbit") throw new Error("agent unavailable");
    }),
    /could not clear chats for cus_orbit/
  );
  assert.deepEqual(env.calls.terminated, ["run-1"]);
  assert.deepEqual(env.calls.processor, ["POST /demo/reset-all"]);
  assert.deepEqual(await dump(db), await dump(fresh));
  assert.deepEqual(cleared.sort(), ["cus_acme", "cus_nimbus", "cus_orbit"]);

  const retry = await resetDemo(resetEnv(db), scripts(), async () => {});
  assert.equal(retry.customers.length, 3);
});

test("demo reset fails unless every active run is really over", async (t) => {
  const db = await database(t);
  const id = await paidInvoice(db);
  const own = (workflowId) =>
    db
      .prepare(
        "UPDATE payment_collections SET owner_active = 1, owner_id = 'o', workflow_id = ? WHERE invoice_id = ?"
      )
      .bind(workflowId, id)
      .run();
  const noChats = async () => {};

  for (const workflowId of ["running", "flaky"]) {
    await own(workflowId);
    const env = resetEnv(db);
    await assert.rejects(resetDemo(env, scripts(), noChats));
    assert.deepEqual(env.calls.processor, [], `${workflowId}: nothing changed`);
    assert.equal((await getPaymentCollection(db, id)).status, "paid");
  }
  for (const workflowId of ["ended", "missing"]) {
    const used = await database(t);
    await paidInvoice(used);
    await used
      .prepare(
        "UPDATE payment_collections SET owner_active = 1, owner_id = 'o', workflow_id = ?"
      )
      .bind(workflowId)
      .run();
    const env = resetEnv(used);
    await resetDemo(env, scripts(), noChats);
    assert.deepEqual(env.calls.processor, ["POST /demo/reset-all"], workflowId);
  }
});

test("demo reset bootstraps an empty hosted database", async (t) => {
  const fresh = await database(t);
  const db = await database(t, { seed: false, through: "" });
  const env = resetEnv(db);
  const result = await resetDemo(env, scripts(), async () => {});
  assert.deepEqual(env.calls.terminated, []);
  assert.deepEqual(await dump(db), await dump(fresh));
  assert.equal(result.customers.length, 3);
});
