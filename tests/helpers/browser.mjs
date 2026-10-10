// Headless Chrome/Edge driven over the DevTools protocol, with a fresh
// profile. Never attaches to an existing browser or profile.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A test server's first page load also builds its client dependencies. */
export const FIRST_LOAD_MS = 60_000;

export async function until(read, label, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`Browser timeout: ${label}`);
}

/**
 * Runs `body({ send, evaluate, responses })` against one page. Returns false
 * without running it when no browser is installed.
 */
export async function withBrowser(body) {
  const browser =
    process.env.PAYMENT_UI_BROWSER ??
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/chromium",
      "/usr/bin/google-chrome"
    ].find(existsSync);
  if (!browser) return false;
  const profile = await mkdtemp(path.join(tmpdir(), "browser-profile-"));
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
    const responses = [];
    socket.addEventListener("message", ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === "Network.responseReceived")
        responses.push(message.params.response);
      const request = pending.get(message.id);
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
    await body({ send, evaluate, responses });
    return true;
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
