/**
 * Workers AI streams Llama 3.3 chunks in two formats at once: native fields
 * (`response`, top-level `tool_calls`) and the OpenAI-style
 * `choices[0].delta`. workers-ai-provider (3.x and 4.0) reads both, so every
 * text token reaches the chat twice and tool-call arguments are interleaved
 * into invalid JSON. This wrapper drops the native copy whenever the OpenAI
 * delta is present, before the provider parses the stream.
 */
export function withDedupedStreamText(ai: Ai): Ai {
  return new Proxy(ai, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (prop === "run") {
        const run = value as (...args: unknown[]) => Promise<unknown>;
        return async (...args: unknown[]) => {
          const result = await run.apply(target, args);
          return result instanceof ReadableStream
            ? result.pipeThrough(dedupeSseText())
            : result;
        };
      }
      // Native binding methods must keep the real binding as `this`
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

/** Rewrites `data:` lines of a server-sent-event byte stream. */
export function dedupeSseText(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      // An event can be split across network chunks; only rewrite whole lines
      const end = pending.lastIndexOf("\n") + 1;
      if (end === 0) return;
      controller.enqueue(encoder.encode(rewriteLines(pending.slice(0, end))));
      pending = pending.slice(end);
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewriteLines(pending)));
    }
  });
}

function rewriteLines(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.startsWith("data:")) return line;
      const data = line.slice(5).trim();
      if (!data.startsWith("{")) return line;
      let event: {
        response?: unknown;
        tool_calls?: unknown;
        choices?: { delta?: { content?: unknown; tool_calls?: unknown } }[];
      };
      try {
        event = JSON.parse(data);
      } catch {
        return line;
      }
      const delta = event.choices?.[0]?.delta;
      let changed = false;
      // Compared loosely on purpose: numeric tokens arrive as JSON numbers in
      // `response` (5) but as strings in the delta ("5").
      if (typeof delta?.content === "string" && "response" in event) {
        delete event.response;
        changed = true;
      }
      // The delta's tool calls are complete (id, index, string arguments);
      // the top-level copy repeats them and sometimes turns arguments into numbers.
      if (
        Array.isArray(delta?.tool_calls) &&
        delta.tool_calls.length > 0 &&
        "tool_calls" in event
      ) {
        delete event.tool_calls;
        changed = true;
      }
      return changed ? `data: ${JSON.stringify(event)}` : line;
    })
    .join("\n");
}
