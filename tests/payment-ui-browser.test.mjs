// Real Chromium + real React controls, deterministic HTTP fixtures; no LLM or user DB.
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { build } from "esbuild";

const browser =
  process.env.PAYMENT_UI_BROWSER ??
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/chromium",
    "/usr/bin/google-chrome"
  ].find(existsSync);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, label, ms = 12000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    message.error
      ? request.reject(new Error(JSON.stringify(message.error)))
      : request.resolve(message.result);
  });
  return {
    socket,
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    }
  };
}

const base = {
  invoiceId: "inv_cus_acme_2026-09",
  customerId: "cus_acme",
  currency: "USD",
  status: "open",
  totalCents: 500,
  creditedCents: 0,
  paidCents: 0,
  reservedCents: 0,
  balanceCents: 500,
  creditableCents: 500,
  attemptsUsed: 0,
  attemptsRemaining: 4,
  methodVersion: 1,
  generation: 0,
  workflowId: null,
  ownerId: null,
  ownerActive: 0,
  hasConflict: 0,
  needsAttention: 0,
  updatedAt: "2026-10-01T00:00:00Z"
};

function customer(id) {
  return {
    customer: {
      id,
      name: id === "cus_acme" ? "Acme test account" : "Orbit test account",
      email: `${id}@example.test`,
      planName: "Starter",
      balanceCents: 500
    },
    invoices: [
      {
        id: `inv_${id}_2026-09`,
        periodStart: "2026-09-01T00:00:00Z",
        status: "finalized",
        totalCents: 500,
        creditedCents: 0
      }
    ],
    currentUsage: {
      month: "2026-10",
      meters: [
        {
          meterId: "test",
          name: "Existing usage",
          quantity: 42,
          unit: "requests"
        }
      ]
    },
    months: [{ month: "2026-09", status: "finalized" }]
  };
}

test(
  "admin dialog and customer view browser journey: queues, review, inbox recovery, late paid, errors and customer races",
  { skip: !browser, timeout: 90000 },
  async (t) => {
    const bundle = await build({
      stdin: {
        contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {BillingPanel} from './src/components/billing-panel'; import {AdminPage} from './src/components/admin-page'; const root=createRoot(document.getElementById('root')); const customers=[{id:'cus_acme',name:'Acme test account'},{id:'cus_orbit',name:'Orbit test account'}]; window.showCustomer=(id)=>root.render(<BillingPanel key={id} customerId={id} refreshKey={0}/>); window.showAdmin=()=>root.render(<AdminPage customers={customers}/>); window.showAdmin();`,
        resolveDir: process.cwd(),
        loader: "tsx"
      },
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      define: { "process.env.NODE_ENV": '"development"' }
    });
    let payment = { ...base };
    let inbox = [];
    let failReconcile = false;
    let delayReconcile = false;
    let releaseReconcile;
    let delayCustomer = null;
    let releaseCustomer;
    let queued = [];
    const calls = [];
    const server = createServer(async (req, res) => {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname === "/") {
        res.setHeader("content-type", "text/html");
        res.end(
          '<!doctype html><html><body><div id="root"></div><script type="module" src="/ui.js"></script></body></html>'
        );
        return;
      }
      if (url.pathname === "/ui.js") {
        res.setHeader("content-type", "text/javascript");
        res.end(bundle.outputFiles[0].text);
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ path: url.pathname, method: req.method, body });
      res.setHeader("content-type", "application/json");
      const send = (value) => res.end(JSON.stringify(value));
      if (url.pathname.startsWith("/api/customers/")) {
        const id = url.pathname.split("/").at(-1);
        if (delayCustomer === id) {
          delayCustomer = null;
          await new Promise((resolve) => {
            releaseCustomer = resolve;
          });
        }
        send(customer(id));
        return;
      }
      if (url.pathname === "/api/payments") {
        const orbit = {
          ...base,
          customerId: "cus_orbit",
          invoiceId: "inv_cus_orbit_2026-09"
        };
        const scope = url.searchParams.get("customerId");
        send(
          scope === null
            ? [payment, orbit]
            : scope === "cus_acme"
              ? [payment]
              : [orbit]
        );
        return;
      }
      if (url.pathname === "/api/payments/inbox") {
        send(
          url.searchParams.get("all") === "true" ||
            url.searchParams.get("customerId") === "cus_acme"
            ? inbox
            : []
        );
        return;
      }
      if (url.pathname.startsWith("/api/invoices/")) {
        send({
          lines: [
            {
              lineNo: 1,
              description: "Existing invoice line",
              amountCents: 500
            }
          ],
          credits: [
            {
              id: "credit-1",
              reason: "Existing approved credit",
              approvedBy: "support",
              amountCents: 100
            }
          ]
        });
        return;
      }
      if (url.pathname.endsWith("/settle")) {
        send({ invoiceId: payment.invoiceId });
        return;
      }
      if (url.pathname.endsWith("/debug-reset")) {
        // Debug reset keeps the customer's card version.
        payment = {
          ...base,
          methodVersion: payment.methodVersion,
          generation: 2,
          updatedAt: "2026-10-01T00:00:03Z"
        };
        queued = [];
        send({ ...payment, attempts: [], timeline: [] });
        return;
      }
      if (url.pathname.endsWith("/processor")) {
        send({ invoiceId: payment.invoiceId, scenarios: queued });
        return;
      }
      if (url.pathname.endsWith("/scenarios")) {
        queued = body.scenarios;
        send({ invoiceId: payment.invoiceId, scenarios: queued });
        return;
      }
      if (url.pathname.endsWith("/collect")) {
        queued = queued.slice(1);
        payment = {
          ...payment,
          status: "needs_review",
          reservedCents: 500,
          creditableCents: 0,
          attemptsUsed: 1,
          attemptsRemaining: 3,
          needsAttention: 1,
          generation: 1,
          workflowId: "workflow-ended",
          updatedAt: "2026-10-01T00:00:01Z"
        };
        inbox = [
          {
            eventId: "inbox-not-applied",
            outcome: {
              invoiceId: payment.invoiceId,
              attemptId: "attempt-1",
              status: "succeeded"
            }
          }
        ];
        send({ id: payment.workflowId, started: true, collection: payment });
        return;
      }
      if (url.pathname === "/api/payments/method") {
        payment = { ...payment, methodVersion: 2 };
        send({ customerId: body.customerId, methodVersion: 2 });
        return;
      }
      if (url.pathname === "/api/payments/reconcile") {
        if (delayReconcile)
          await new Promise((resolve) => {
            releaseReconcile = resolve;
          });
        if (failReconcile) {
          res.statusCode = 409;
          send({ error: { message: "Mock reconciliation unavailable" } });
          return;
        }
        send({
          inbox: [{ eventId: "inbox-not-applied", applied: false }],
          checks: [
            {
              invoiceId: payment.invoiceId,
              attemptId: "attempt-1",
              result: "unresolved"
            }
          ],
          runs: [],
          issues: []
        });
        return;
      }
      if (url.pathname.endsWith("/run")) {
        send({
          id: payment.workflowId,
          status: payment.workflowId ? "complete" : "not_started"
        });
        return;
      }
      if (url.pathname.startsWith("/api/payments/inv_")) {
        send({
          ...payment,
          attempts: payment.attemptsUsed
            ? [
                {
                  id: "attempt-1",
                  attemptNumber: 1,
                  state: "needs_review",
                  amountCents: 500,
                  idempotencyKey: "stable-original-key",
                  processorPaymentId: "processor-1",
                  generation: 1,
                  methodVersion: 1,
                  updatedAt: payment.updatedAt
                }
              ]
            : [],
          timeline: [
            {
              id: "timeline-1",
              generation: 1,
              attemptNumber: 1,
              kind: "recovery_check",
              message: "Durable recovery notice",
              createdAt: payment.updatedAt,
              deadlineAt: null
            }
          ]
        });
        return;
      }
      res.statusCode = 404;
      send({ error: { message: "Unknown fixture endpoint" } });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      releaseCustomer?.();
      releaseReconcile?.();
      server.closeAllConnections();
      server.close();
    });
    const profile = mkdtempSync(join(tmpdir(), "payment-ui-browser-"));
    const child = spawn(
      browser,
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank"
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    t.after(async () => {
      child.kill();
      await sleep(700);
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 200
      });
    });
    await until(
      () => /DevTools listening on (ws:\/\/\S+)/.test(stderr),
      "Chromium startup"
    );
    const debugUrl = new URL(
      stderr.match(/DevTools listening on (ws:\/\/\S+)/)[1]
    );
    const targets = await (
      await fetch(`http://${debugUrl.host}/json/list`)
    ).json();
    const cdp = await connect(
      targets.find((target) => target.type === "page").webSocketDebuggerUrl
    );
    t.after(() => cdp.socket.close());
    const evaluate = async (expression) => {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    const text = () => evaluate("document.body.innerText");
    const waitText = (needle) =>
      until(async () => (await text()).includes(needle), needle);
    const click = (label) =>
      evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`
      );
    await cdp.send("Page.navigate", {
      url: `http://127.0.0.1:${server.address().port}/`
    });
    const buttonDisabled = (label) =>
      evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).disabled`
      );
    const tab = (label) =>
      evaluate(
        `Array.from(document.querySelectorAll('[role=tab]')).find(t=>t.textContent===${JSON.stringify(label)}).click()`
      );
    const dialogText = () =>
      evaluate("document.querySelector('[role=dialog]')?.innerText ?? ''");

    // Admin console: every customer's collection in one table.
    // Customer names also appear in the filter dropdown; wait for table rows.
    await until(
      () =>
        evaluate(
          "['Acme','Orbit'].every(n=>Array.from(document.querySelectorAll('tbody tr')).some(r=>r.textContent.includes(n)))"
        ),
      "admin collection rows"
    );
    assert.match(await text(), /Needs review/);
    await evaluate(
      "Array.from(document.querySelectorAll('tbody tr')).find(r=>r.textContent.includes('Acme')).querySelector('button').click()"
    );
    await waitText("Ready to collect");
    assert.match(await dialogText(), /Acme test account · September 2026/);
    assert.match(await dialogText(), /0 of 4 used/);
    await tab("Mock controls");
    await evaluate(
      "const s=document.querySelector('select[aria-label=\"Mock scenario\"]'); s.value='4'; s.dispatchEvent(new Event('change',{bubbles:true}));"
    );
    // Choosing a scenario applies it immediately; there is no separate save.
    await waitText("Mock queue set: lost response");
    await waitText("Mock: next outcome lost response");
    assert.deepEqual(queued, ["lost_response"]);
    await click("Collect");
    await waitText("1 of 4 used");
    await until(
      async () => !(await text()).includes("Mock: next outcome"),
      "queue consumed by the charge"
    );
    await waitText("Result unknown · waiting for the processor");
    await waitText("Collect blocked: $5.00 held for an unresolved charge");
    assert.equal(await buttonDisabled("Collect"), true);
    // An unresolved charge locks the queue but can be settled at the processor.
    await tab("Mock controls");
    await waitText("Locked while a charge is unresolved");
    await click("Soft decline");
    await waitText("Processor settled the charge: soft decline");
    assert.deepEqual(calls.findLast((c) => c.path.endsWith("/settle")).body, {
      outcome: "soft_decline"
    });
    await tab("Activity");
    await waitText("Durable recovery notice");
    await tab("Debug");
    await waitText("stable-original-key");
    await waitText("workflow-ended");
    await click("Reconcile");
    await waitText("attempt attempt-1: unresolved");
    assert.match(await text(), /event inbox-not-applied: unapplied/);
    assert.deepEqual(
      calls.findLast((c) => c.path === "/api/payments/reconcile").body,
      { invoiceId: payment.invoiceId, resume: false }
    );
    await click("Reconcile + resume");
    await until(
      () =>
        calls.findLast((c) => c.path === "/api/payments/reconcile").body
          .resume === true,
      "resume reconciliation"
    );
    await tab("Mock controls");
    await click("Simulate card update");
    await waitText("Card updated to version 2.");
    assert.deepEqual(
      calls.findLast((c) => c.path === "/api/payments/method").body,
      { customerId: "cus_acme", expectedVersion: 1 }
    );
    failReconcile = true;
    await click("Reconcile");
    await waitText("Mock reconciliation unavailable");
    // Late financial success is visible without restarting the completed Workflow.
    payment = {
      ...payment,
      status: "paid",
      paidCents: 500,
      reservedCents: 0,
      balanceCents: 0,
      creditableCents: 0,
      needsAttention: 0,
      updatedAt: "2026-10-01T00:00:02Z"
    };
    inbox = [];
    await waitText("Paid in full");
    assert.equal(await buttonDisabled("Collect"), true);
    failReconcile = false;
    delayReconcile = true;
    await click("Reconcile");
    await until(() => Boolean(releaseReconcile), "delayed reconciliation");
    await waitText("Reconciling…");
    assert.equal(await buttonDisabled("Reconcile"), true);
    assert.equal(await buttonDisabled("Simulate card update"), true);
    // Closing mid-request must not surface the late result anywhere.
    await evaluate(
      "document.querySelector('[role=dialog] button[aria-label=Close]').click()"
    );
    await until(async () => !(await dialogText()), "dialog closed");
    releaseReconcile();
    delayReconcile = false;
    releaseReconcile = undefined;
    await sleep(300);
    assert.doesNotMatch(await text(), /Reconciled \d+ events/);
    await click("Reconcile all");
    await until(
      () =>
        calls.findLast((c) => c.path === "/api/payments/reconcile").body
          .invoiceId === undefined,
      "reconcile all"
    );

    // Debug reset needs an explicit confirmation, then reopens the invoice.
    await evaluate(
      "Array.from(document.querySelectorAll('tbody tr')).find(r=>r.textContent.includes('Acme')).querySelector('button').click()"
    );
    await waitText("Paid in full");
    await tab("Debug");
    await click("Reset to unpaid");
    await waitText("Credits stay.");
    await click("Cancel");
    await until(
      async () => !(await text()).includes("Credits stay."),
      "reset cancelled"
    );
    assert.equal(
      calls.filter((c) => c.path.endsWith("/debug-reset")).length,
      0
    );
    await click("Reset to unpaid");
    await click("Reset");
    await waitText("Reset to unpaid. Payment history cleared.");
    await waitText("Ready to collect");
    await waitText("0 of 4 used");
    assert.equal(
      calls.filter((c) => c.path.endsWith("/debug-reset")).length,
      1
    );
    await evaluate(
      "document.querySelector('[role=dialog] button[aria-label=Close]').click()"
    );
    await until(async () => !(await dialogText()), "dialog closed after reset");

    // Customer view: plain status, no operator controls.
    await evaluate("window.showCustomer('cus_acme')");
    await waitText("Card on file · v2");
    assert.match(await text(), /Existing usage/);
    assert.match(await text(), /Due\s+\$5\.00/);
    assert.doesNotMatch(
      await text(),
      /Collect|Reconcile|Workflow|attempt|needs review|Mock/i
    );
    await evaluate(
      "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('September 2026')).click()"
    );
    await waitText("Existing invoice line");
    await waitText("Existing approved credit");
    await click("Update card");
    await waitText("Card updated.");
    assert.deepEqual(
      calls.findLast((c) => c.path === "/api/payments/method").body,
      { customerId: "cus_acme", expectedVersion: 2 }
    );
    delayCustomer = "cus_acme";
    await click("Refresh");
    await until(() => Boolean(releaseCustomer), "delayed old customer read");
    await evaluate("window.showCustomer('cus_orbit')");
    await waitText("Orbit test account");
    releaseCustomer();
    await sleep(300);
    assert.doesNotMatch(await text(), /Acme test account|Card updated/);
  }
);
