import assert from "node:assert/strict";
import test from "node:test";
import { dedupeSseText, withDedupedStreamText } from "../src/workers-ai.ts";

const encoder = new TextEncoder();

async function rewrite(chunks) {
  const source = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(source.pipeThrough(dedupeSseText())).text();
}

const event = (fields) => `data: ${JSON.stringify(fields)}\n\n`;

test("drops the native response copy when it duplicates the OpenAI delta", async () => {
  const out = await rewrite([
    event({ choices: [{ delta: { content: "hello" } }], response: "hello" })
  ]);
  assert.deepEqual(JSON.parse(out.trim().slice(5)), {
    choices: [{ delta: { content: "hello" } }]
  });
});

test("drops numeric native copies of numeric tokens", async () => {
  const out = await rewrite([
    event({ choices: [{ delta: { content: "5" } }], response: 5 })
  ]);
  assert.deepEqual(JSON.parse(out.trim().slice(5)), {
    choices: [{ delta: { content: "5" } }]
  });
});

test("keeps native-only and non-JSON events unchanged", async () => {
  const native = event({ response: "", usage: { total_tokens: 45 } });
  const input = native + "data: [DONE]\n\n";
  assert.equal(await rewrite([input]), input);
});

test("handles events split across network chunks, including multibyte text", async () => {
  const full = event({
    choices: [{ delta: { content: "€5 credit" } }],
    response: "€5 credit"
  });
  const bytes = encoder.encode(full);
  // Split inside the multibyte euro sign and in the middle of the JSON line
  const source = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 27));
      controller.enqueue(bytes.slice(27, 40));
      controller.enqueue(bytes.slice(40));
      controller.close();
    }
  });
  const out = await new Response(source.pipeThrough(dedupeSseText())).text();
  assert.equal(out, event({ choices: [{ delta: { content: "€5 credit" } }] }));
});

test("binding wrapper only rewrites streams and preserves other members", async () => {
  const calls = [];
  const binding = {
    marker: "real",
    async run(...args) {
      calls.push({ args, self: this });
      return args[1].stream
        ? new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  event({
                    choices: [{ delta: { content: "x" } }],
                    response: "x"
                  })
                )
              );
              controller.close();
            }
          })
        : { response: "plain" };
    },
    gateway() {
      return this.marker;
    }
  };
  const ai = withDedupedStreamText(binding);
  assert.deepEqual(await ai.run("m", { stream: false }), { response: "plain" });
  const streamed = await new Response(
    await ai.run("m", { stream: true })
  ).text();
  assert.ok(!streamed.includes('"response"'));
  assert.equal(calls[0].self, binding);
  assert.equal(ai.gateway(), "real");
});

test("drops top-level tool calls that duplicate the OpenAI delta", async () => {
  const delta = [{ function: { arguments: "202" }, index: 0 }];
  const out = await rewrite([
    event({
      tool_calls: [{ arguments: 202 }],
      choices: [{ delta: { tool_calls: delta } }]
    })
  ]);
  assert.deepEqual(JSON.parse(out.trim().slice(5)), {
    choices: [{ delta: { tool_calls: delta } }]
  });
});

test("keeps native-only tool calls when the delta has none", async () => {
  const input =
    event({ tool_calls: [{ name: "getInvoice", arguments: "{}" }] }) +
    event({ tool_calls: [], choices: [{ delta: {} }] });
  assert.equal(await rewrite([input]), input);
});
