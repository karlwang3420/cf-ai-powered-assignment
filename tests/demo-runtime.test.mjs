// Hosted demo mode in the real Vite runtime (both Workers, D1, Durable Objects,
// Workflows), with a local stand-in for the Access signing keys. Uses only a
// fresh OS-temp persistence directory and never calls Workers AI.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { FIRST_LOAD_MS, until, withBrowser } from "./helpers/browser.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function eventually(read, accepts, timeout = 30_000) {
  let value;
  const end = Date.now() + timeout;
  do {
    value = await read();
    if (accepts(value)) return value;
    await delay(150);
  } while (Date.now() < end);
  assert.fail(`condition timed out: ${JSON.stringify(value)}`);
}

const AUD = "runtime-aud";
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
  kid: "runtime"
};
const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
async function signIn(issuer, sub) {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "RS256", kid: "runtime" })}.${b64({
    aud: [AUD],
    iss: issuer,
    sub,
    email: `${sub}@cloudflare.com`,
    iat: now,
    exp: now + 3600
  })}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    keys.privateKey,
    new TextEncoder().encode(body)
  );
  return `${body}.${Buffer.from(signature).toString("base64url")}`;
}

/** Whether a browser-like chat socket from `from` gets through. */
async function chatConnects(origin, token, from) {
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/agents/billing-assistant/cus_acme`,
    { headers: { "Cf-Access-Jwt-Assertion": token, Origin: from } }
  );
  const opened = await new Promise((resolve) => {
    socket.addEventListener("open", () => resolve(true));
    socket.addEventListener("error", () => resolve(false));
    setTimeout(() => resolve(false), 10_000);
  });
  socket.close();
  return opened;
}

/** Saves chat messages over the socket, as the chat UI does. */
async function saveChat(origin, token, messages) {
  const socket = new WebSocket(
    `${origin.replace("http", "ws")}/agents/billing-assistant/cus_acme`,
    { headers: { "Cf-Access-Jwt-Assertion": token } }
  );
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", () => reject(new Error("no socket")));
  });
  socket.send(JSON.stringify({ type: "cf_agent_chat_messages", messages }));
  await delay(500);
  socket.close();
}

/** Chat history, read the way the chat UI loads it. */
async function chatHistory(origin, token) {
  const response = await fetch(
    `${origin}/agents/billing-assistant/cus_acme/get-messages`,
    { headers: { "Cf-Access-Jwt-Assertion": token } }
  );
  assert.equal(response.status, 200);
  return response.json();
}

test(
  "hosted demo: Access gate, first-request seeding, overlap protection and a full reset",
  { timeout: 180_000 },
  async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), "demo-vite-runtime-"));
    const certs = createHttpServer((req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ keys: [jwk] }));
    });
    await new Promise((resolve) => certs.listen(0, "127.0.0.1", resolve));
    const issuer = `http://127.0.0.1:${certs.address().port}`;
    const saved = Object.fromEntries(
      [
        "PAYMENT_TEST_PERSIST",
        "DEMO_ACCESS_TEAM_DOMAIN",
        "DEMO_ACCESS_AUD"
      ].map((name) => [name, process.env[name]])
    );
    Object.assign(process.env, {
      PAYMENT_TEST_PERSIST: directory,
      DEMO_ACCESS_TEAM_DOMAIN: issuer,
      DEMO_ACCESS_AUD: AUD
    });
    let server;
    t.after(async () => {
      await server?.close();
      certs.close();
      for (const [name, value] of Object.entries(saved))
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      await rm(directory, { recursive: true, force: true });
    });
    server = await createServer({
      configFile: path.join(root, "vite.config.ts"),
      mode: "payment-test",
      // Own dependency cache: a shared one is rebuilt whenever another Vite
      // server (a parallel test or your dev server) has a different config.
      cacheDir: path.join(directory, "vite-cache"),
      server: { host: "127.0.0.1", port: 0 },
      clearScreen: false,
      plugins: [
        {
          // Test-only: a route that makes the next D1 rebuild fail once,
          // after the processor has already been cleared
          name: "demo-reset-failure-fixture",
          enforce: "pre",
          transform(code, id) {
            const file = id.replaceAll("\\", "/");
            if (file.endsWith("/src/server.ts")) {
              // Miniflare can return cleanly before the SDK's scheduled abort.
              // Force the production RPC teardown signal after actual deletion.
              const agentSeam = "  maxPersistedMessages = 100;";
              assert.ok(code.includes(agentSeam));
              code = code.replace(
                agentSeam,
                `${agentSeam}
  async destroy() {
    await super.destroy();
    throw new Error("destroyed");
  }`
              );
              const seam = "async fetch(request: Request, env: Env) {";
              assert.ok(code.includes(seam));
              return code.replace(
                seam,
                `${seam}
          if (new URL(request.url).pathname === "/api/__test-fail-next-rebuild") {
            await env.DB.prepare("CREATE TABLE IF NOT EXISTS test_fail_rebuild (x)").run();
            return new Response(null, { status: 204 });
          }`
              );
            }
            if (file.endsWith("/src/demo/reset.ts")) {
              const seam =
                "  await rebuildDatabase(env.DB, scripts, migrations);";
              assert.ok(code.includes(seam));
              return code.replace(
                seam,
                `  if (await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'test_fail_rebuild'").first()) {
    await env.DB.prepare("DROP TABLE test_fail_rebuild").run();
    throw new Error("injected rebuild failure");
  }
${seam}`
              );
            }
          }
        }
      ]
    });
    await server.listen();
    const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    const as =
      (token) =>
      async (pathname, method = "GET", body) => {
        const response = await fetch(`${origin}/api${pathname}`, {
          method,
          headers: {
            "content-type": "application/json",
            ...(token ? { "Cf-Access-Jwt-Assertion": token } : {})
          },
          body: body === undefined ? undefined : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
      };
    const alice = await signIn(issuer, "alice");
    const bob = await signIn(issuer, "bob");
    const asAlice = as(alice);
    const asBob = as(bob);

    assert.equal((await as(null)("/customers")).status, 403);
    assert.equal(
      (await as(await signIn("https://other.example", "x"))("/customers"))
        .status,
      403,
      "a token from another issuer"
    );

    // The very first requests, concurrently, seed the empty database once
    const first = await Promise.all(
      Array.from({ length: 4 }, () => asAlice("/demo"))
    );
    assert.ok(first.every((r) => r.status === 200));
    assert.equal(first.filter((r) => r.body.reset).length, 1);
    assert.equal(new Set(first.map((r) => r.body.lastResetAt)).size, 1);
    assert.equal((await asAlice("/customers")).body.length, 3);

    // Alice works: an invoice is paid and a chat message saved
    const run = await asAlice("/invoice-runs", "POST", {
      customerId: "cus_acme",
      month: "2026-09"
    });
    assert.equal(run.status, 202);
    await eventually(
      () => asAlice(`/invoice-runs/${run.body.id}`),
      (r) => r.body.status === "complete"
    );
    await asAlice("/payments/inv_cus_acme_2026-09/collect", "POST");
    const paid = await eventually(
      () => asAlice("/payments/inv_cus_acme_2026-09"),
      (r) => r.body.status === "paid"
    );
    const charged = (await asAlice("/payments/inv_cus_acme_2026-09/processor"))
      .body.requests[0].charge.processorPaymentId;
    // The processor's signed callback still reaches the gated Worker over the
    // service binding; the same path from outside needs Access
    await eventually(
      () => asAlice("/payments/inv_cus_acme_2026-09/processor"),
      (r) =>
        r.body.outbox.length > 0 &&
        r.body.outbox.every((e) => e.state === "delivered")
    );
    assert.equal((await as(null)("/payments/webhook", "POST", {})).status, 403);

    // A page on another site cannot chat with a reviewer's Access session
    assert.equal(await chatConnects(origin, alice, origin), true);
    assert.equal(
      await chatConnects(origin, alice, "https://evil.example"),
      false
    );
    const crossSite = await fetch(
      `${origin}/agents/billing-assistant/cus_acme/get-messages`,
      {
        headers: {
          "Cf-Access-Jwt-Assertion": alice,
          Origin: "https://evil.example"
        }
      }
    );
    assert.equal(crossSite.status, 403);
    assert.match(await crossSite.text(), /Cross-origin requests/);
    const crossSiteRead = await fetch(`${origin}/api/demo`, {
      headers: {
        "Cf-Access-Jwt-Assertion": alice,
        Origin: "https://evil.example"
      }
    });
    assert.equal(crossSiteRead.status, 403, "refused before admission");
    await saveChat(origin, alice, [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] }
    ]);
    assert.equal((await chatHistory(origin, alice)).length, 1);

    // Bob signs in while Alice is active: nothing is wiped, and he is told
    const overlap = await asBob("/demo");
    assert.equal(overlap.body.reset, false);
    assert.equal(overlap.body.othersActive, true);
    assert.equal(
      (await asBob("/payments/inv_cus_acme_2026-09")).body.paidCents,
      paid.body.paidCents
    );

    // Cross-site forms cannot reset; Bob's explicit reset returns the seed
    assert.equal(
      (
        await fetch(`${origin}/api/demo/reset`, {
          method: "POST",
          headers: {
            "Cf-Access-Jwt-Assertion": bob,
            Origin: "https://evil.example"
          }
        })
      ).status,
      403
    );
    const reset = await asBob("/demo/reset", "POST");
    assert.equal(reset.status, 200);
    assert.equal(reset.body.reset, true);
    assert.equal((await asAlice("/payments/inv_cus_acme_2026-09")).status, 404);
    assert.equal((await asAlice("/customers")).body.length, 3);
    assert.deepEqual(
      await chatHistory(origin, alice),
      [],
      "chat history cleared"
    );

    // The processor forgot the old key: the same attempt charges afresh
    const rerun = await asAlice("/invoice-runs", "POST", {
      customerId: "cus_acme",
      month: "2026-09"
    });
    await eventually(
      () => asAlice(`/invoice-runs/${rerun.body.id}`),
      (r) => r.body.status === "complete"
    );
    await asAlice("/payments/inv_cus_acme_2026-09/collect", "POST");
    await eventually(
      () => asAlice("/payments/inv_cus_acme_2026-09"),
      (r) => r.body.status === "paid"
    );
    const processor = (
      await asAlice("/payments/inv_cus_acme_2026-09/processor")
    ).body;
    assert.equal(processor.requests.length, 1);
    assert.notEqual(processor.requests[0].charge.processorPaymentId, charged);

    // A reset that fails after clearing the processor is retried by the next
    // request, even from a session that would not otherwise reset
    assert.equal(
      (await fetch(`${origin}/api/__test-fail-next-rebuild`)).status,
      204
    );
    const failed = await asBob("/demo/reset", "POST");
    assert.equal(failed.status, 500);
    // Alice is active and known, so only the pending mark makes this reset
    const retried = await asAlice("/demo");
    assert.equal(retried.body.reset, true);
    assert.equal((await asAlice("/payments/inv_cus_acme_2026-09")).status, 404);
    assert.equal((await asAlice("/demo")).body.reset, false, "done once");

    // The banner in a real browser, signed in as a third reviewer
    const carol = await signIn(issuer, "carol");
    const ran = await withBrowser(async ({ send, evaluate }) => {
      await send("Network.enable");
      await send("Network.setExtraHTTPHeaders", {
        headers: { "Cf-Access-Jwt-Assertion": carol }
      });
      const text = () => evaluate("document.body.innerText");
      const click = (label) =>
        evaluate(
          `[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(label)}).click()`
        );
      await send("Page.navigate", { url: origin });
      // The first load also builds the client dependencies in a fresh cache
      await until(
        async () => (await text()).includes("Shared demo"),
        "banner",
        FIRST_LOAD_MS
      );
      assert.match(await text(), /Someone else has used it/);
      assert.doesNotMatch(await text(), /reset since this page loaded/);

      // Bob resets elsewhere; opening Reset demo re-reads the status
      assert.equal((await asBob("/demo/reset", "POST")).status, 200);
      await click("Reset demo");
      await until(
        async () => (await text()).includes("reset since this page loaded"),
        "reset elsewhere"
      );
      await click("Cancel");
      await until(async () => (await text()).includes("Reload"), "reload");

      // Confirming a reset reloads onto the fresh data
      const before = (await asAlice("/demo")).body.lastResetAt;
      await click("Reset demo");
      await until(
        async () => (await text()).includes("for everyone?"),
        "confirm"
      );
      await click("Reset");
      await until(
        async () => (await asAlice("/demo")).body.lastResetAt !== before,
        "browser reset"
      );
      await until(
        async () =>
          (await text()).includes("Shared demo") &&
          !(await text()).includes("reset since this page loaded"),
        "reloaded"
      );
    });
    if (!ran) console.log("DEMO_BANNER_SKIPPED: Chrome/Edge unavailable");
  }
);
