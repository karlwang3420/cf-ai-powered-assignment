import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

async function fixture(t) {
  const base = mkdtempSync(join(tmpdir(), "pi-prompts-"));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, "repo");
  const extension = join(repo, ".pi", "extensions", "prompt-history.ts");
  mkdirSync(dirname(extension), { recursive: true });
  mkdirSync(join(repo, ".git"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ type: "module" }));
  copyFileSync(
    new URL("../.pi/extensions/prompt-history.ts", import.meta.url),
    extension
  );
  const { default: register } = await import(pathToFileURL(extension).href);
  let handler;
  register({
    on(name, callback) {
      assert.equal(name, "input");
      handler = callback;
    }
  });
  const errors = [];
  const ctx = {
    cwd: repo,
    hasUI: true,
    ui: {
      notify(message) {
        errors.push(message);
      }
    }
  };
  const path = join(repo, "PROMPTS.md");
  return {
    base,
    repo,
    path,
    errors,
    register,
    input(text, extra = {}, cwd = repo) {
      return handler(
        { text, source: "interactive", ...extra },
        { ...ctx, cwd }
      );
    },
    read() {
      return readFileSync(path, "utf8");
    }
  };
}

function clock(t) {
  const OriginalDate = globalThis.Date;
  let value = new OriginalDate(2026, 9, 7, 12, 34, 56);
  globalThis.Date = class extends OriginalDate {
    constructor(...args) {
      super(...(args.length ? args : [value.getTime()]));
    }
  };
  t.after(() => {
    globalThis.Date = OriginalDate;
  });
  return (day) => {
    value = new OriginalDate(2026, 9, day, 12, 34, 56);
  };
}

test("appends prompts with local timestamps, grouping each date on its own line", async (t) => {
  const nextDay = clock(t);
  const f = await fixture(t);
  assert.deepEqual(f.input("first\nsecond line"), { action: "continue" });
  f.input("another", { source: "rpc" });
  const firstDay = f.read();
  assert.match(
    firstDay,
    /^# Prompt History\n\n## 2026-10-07\n\n> \[12:34:56 \(UTC[+-]\d{2}:\d{2}\)\] first\n> second line/
  );
  assert.doesNotMatch(firstDay, /^### /m);
  assert.equal((firstDay.match(/^## /gm) || []).length, 1);
  nextDay(8);
  f.input("tomorrow");
  assert.ok(f.read().startsWith(firstDay));
  assert.match(f.read(), /\n## 2026-10-08\n\n> \[12:34:56 .*\] tomorrow/);
  assert.deepEqual(f.errors, []);
});

test("preserves multiline Markdown and repeated prompts without confusing date headings", async (t) => {
  clock(t);
  const f = await fixture(t);
  const text = "## 2099-01-01\r\n\r\n```js\r\nhello()\r\n```";
  f.input(text);
  f.input(text);
  assert.equal((f.read().match(/^## /gm) || []).length, 1);
  assert.equal(
    (f.read().match(/^> \[12:34:56 .*\] ## 2099-01-01/gm) || []).length,
    2
  );
  assert.doesNotMatch(f.read(), /^### /m);
});

test("ignores synthetic and empty input; notes images without storing binary data", async (t) => {
  const f = await fixture(t);
  f.input("generated", { source: "extension" });
  f.input(" \n\t");
  assert.equal(existsSync(f.path), false);
  f.input("", {
    images: [{ type: "image", data: "PRIVATE_BASE64", mimeType: "image/png" }]
  });
  assert.match(f.read(), /1 image\(s\) attached/);
  assert.ok(!f.read().includes("PRIVATE_BASE64"));
});

test("only logs this repository, including its subdirectories but not nested repositories", async (t) => {
  const f = await fixture(t);
  const outside = join(f.base, "repo-other");
  const subdir = join(f.repo, "src");
  const nestedRepo = join(f.repo, "vendor", "other");
  mkdirSync(outside);
  mkdirSync(subdir);
  mkdirSync(join(nestedRepo, ".git"), { recursive: true });
  f.input("outside", {}, outside);
  f.input("nested repo", {}, nestedRepo);
  assert.equal(existsSync(f.path), false);
  f.input("inside", {}, subdir);
  assert.match(f.read(), /> \[.*\] inside/);
  assert.ok(!f.read().includes("outside"));
  assert.deepEqual(f.errors, []);
});

test("existing logs survive extension reload and missing trailing newlines", async (t) => {
  clock(t);
  const f = await fixture(t);
  writeFileSync(
    f.path,
    "# Prompt History\n\n## 2026-10-07\n\n> [10:00:00 (UTC-04:00)] existing"
  );
  let reloaded;
  f.register({
    on(_name, callback) {
      reloaded = callback;
    }
  });
  reloaded({ text: "new", source: "interactive" }, { cwd: f.repo });
  assert.match(
    f.read(),
    /> \[10:00:00 \(UTC-04:00\)\] existing\n\n> \[12:34:56/
  );
  assert.equal((f.read().match(/^## /gm) || []).length, 1);
});

test("write failures are reported without blocking or transforming the prompt", async (t) => {
  const f = await fixture(t);
  mkdirSync(f.path);
  assert.deepEqual(f.input("still sent"), { action: "continue" });
  assert.equal(f.errors.length, 1);
  assert.match(f.errors[0], /Could not append prompt to PROMPTS.md/);
});
