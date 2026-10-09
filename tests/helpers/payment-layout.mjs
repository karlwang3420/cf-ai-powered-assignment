// Optional real styled-app regression, never attaches to an existing browser/profile.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, label) {
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Browser layout timeout: ${label}`);
}
export async function checkPaymentLayout(origin) {
  const browser =
    process.env.PAYMENT_UI_BROWSER ??
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome"
    ].find(existsSync);
  if (!browser) {
    console.log("PAYMENT_LAYOUT_SKIPPED: Chrome/Edge unavailable");
    return;
  }
  const profile = await mkdtemp(path.join(tmpdir(), "payment-layout-"));
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
  let stderr = "",
    socket;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const match = await until(
      () => stderr.match(/DevTools listening on (ws:\/\/\S+)/),
      "startup"
    );
    const debug = new URL(match[1]);
    const targets = await (
      await fetch(`http://${debug.host}/json/list`)
    ).json();
    socket = new WebSocket(
      targets.find((target) => target.type === "page").webSocketDebuggerUrl
    );
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let id = 0;
    const pending = new Map();
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data),
        request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      message.error
        ? request.reject(new Error(JSON.stringify(message.error)))
        : request.resolve(message.result);
    });
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const next = ++id;
        pending.set(next, { resolve, reject });
        socket.send(JSON.stringify({ id: next, method, params }));
      });
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      });
      assert.equal(
        result.exceptionDetails,
        undefined,
        JSON.stringify(result.exceptionDetails)
      );
      return result.result.value;
    };
    const measure = (width, label) =>
      evaluate(`({scrollWidth:document.documentElement.scrollWidth,
        controls:[...document.querySelectorAll('header select,header button,header a')].filter(e=>e.offsetParent).map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}}),
        overflow:[...document.querySelectorAll('main, main aside, main section, main button, [role=dialog], [role=dialog] button, [role=dialog] dd')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+2).map(e=>e.tagName+':'+e.textContent.slice(0,80)),
        dialog:(()=>{const d=document.querySelector('[role=dialog]');if(!d)return null;const r=d.getBoundingClientRect();return {left:r.left,right:r.right}})()})`).then(
        (layout) => {
          assert.equal(layout.scrollWidth, width, label);
          assert.ok(
            layout.controls.every(
              (r) => r.left >= 0 && r.right <= width && r.width > 0
            ),
            label
          );
          assert.deepEqual(layout.overflow, [], label);
          if (layout.dialog)
            assert.ok(
              layout.dialog.left >= 0 && layout.dialog.right <= width,
              label
            );
        }
      );
    const sizes = async (check) => {
      for (const width of [390, 1280]) {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height: 900,
          deviceScaleFactor: 1,
          mobile: false
        });
        for (const mode of ["light", "dark"]) {
          await evaluate(`document.documentElement.dataset.mode='${mode}'`);
          await sleep(200);
          await check(`${width} ${mode}`, width);
        }
      }
    };

    // Admin console with the long-ID review invoice open on every dialog tab.
    await send("Page.navigate", { url: `${origin}/admin` });
    await until(
      () =>
        evaluate(
          "Array.from(document.querySelectorAll('tbody tr')).some(r=>r.cells[0].textContent==='late')"
        ),
      "admin collections"
    );
    await evaluate(
      "Array.from(document.querySelectorAll('tbody tr')).find(r=>r.cells[0].textContent==='late').querySelector('button').click()"
    );
    await until(
      () => evaluate("!!document.querySelector('[role=dialog]')"),
      "dialog"
    );
    await sizes(async (label, width) => {
      for (const tab of ["Activity", "Mock controls", "Debug"]) {
        await evaluate(
          `Array.from(document.querySelectorAll('[role=tab]')).find(t=>t.textContent===${JSON.stringify(tab)}).click()`
        );
        await sleep(200);
        await measure(width, `${label} admin ${tab}`);
      }
    });

    // Customer view with an exceptionally long customer name.
    await send("Page.navigate", { url: origin });
    await until(
      () =>
        evaluate("document.querySelector('header select')?.options.length > 3"),
      "customers"
    );
    await evaluate(
      `(()=>{const s=document.querySelector('header select');s.value='test_late';s.dispatchEvent(new Event('change',{bubbles:true}));})()`
    );
    await until(
      () => evaluate("document.body.innerText.includes('Card on file')"),
      "customer invoice"
    );
    await sizes(async (label, width) => {
      await evaluate(
        `(()=>{const s=document.querySelector('header select');s.options[s.selectedIndex].text='Very long enterprise customer name with an exceptionally long billing identifier';})()`
      );
      await measure(width, `${label} customer`);
    });
    console.log(
      "PAYMENT_LAYOUT_OK: styled real app; admin dialog tabs + customer view; 390/1280px; light/dark; long customer; no clipped controls/overflow."
    );
  } finally {
    socket?.close();
    child.kill();
    await sleep(700);
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 200
    });
  }
}
