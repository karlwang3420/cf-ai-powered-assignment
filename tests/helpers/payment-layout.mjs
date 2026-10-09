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
      () =>
        evaluate(
          "document.body.innerText.includes('Payment details & controls')"
        ),
      "invoice"
    );
    await evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Payment details & controls')).click()`
    );
    await until(
      () => evaluate("document.body.innerText.includes('Correlation IDs')"),
      "details"
    );
    for (const width of [390, 1280]) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      });
      for (const mode of ["light", "dark"]) {
        await evaluate(
          `(()=>{document.documentElement.dataset.mode='${mode}';const s=document.querySelector('header select');s.options[s.selectedIndex].text='Very long enterprise customer name with an exceptionally long billing identifier';for(const d of document.querySelectorAll('details'))d.open=true;})()`
        );
        await sleep(200);
        const layout =
          await evaluate(`({width:innerWidth,scrollWidth:document.documentElement.scrollWidth,
          controls:[...document.querySelectorAll('header select,header button')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,width:r.width}}),
          overflow:[...document.querySelectorAll('main, main aside, main section, main button')].filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+2).map(e=>e.tagName+':'+e.textContent.slice(0,80))})`);
        assert.equal(layout.scrollWidth, width, `${width} ${mode}`);
        assert.ok(
          layout.controls.every(
            (r) => r.left >= 0 && r.right <= width && r.width > 0
          )
        );
        assert.deepEqual(layout.overflow, [], `${width} ${mode}`);
      }
    }
    console.log(
      "PAYMENT_LAYOUT_OK: styled real app; 390/1280px; light/dark; long customer; expanded IDs; no clipped controls/overflow."
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
