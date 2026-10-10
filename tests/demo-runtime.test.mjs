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
      server: { host: "127.0.0.1", port: 0 },
      clearScreen: false
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
    const paid = await eventually(
      () => asAlice("/payments/inv_cus_acme_2026-09"),
      (r) => r.body.status === "paid"
    );
    const charged = (await asAlice("/payments/inv_cus_acme_2026-09/processor"))
      .body.requests[0].charge.processorPaymentId;
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
    await asAlice("/invoice-runs", "POST", {
      customerId: "cus_acme",
      month: "2026-09"
    });
    await eventually(
      () => asAlice("/payments/inv_cus_acme_2026-09"),
      (r) => r.body.status === "paid"
    );
    const processor = (
      await asAlice("/payments/inv_cus_acme_2026-09/processor")
    ).body;
    assert.equal(processor.requests.length, 1);
    assert.notEqual(processor.requests[0].charge.processorPaymentId, charged);
  }
);
