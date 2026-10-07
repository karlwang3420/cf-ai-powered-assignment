/**
 * Workers AI streams Llama 3.3 chunks in two formats at once: the native
 * `response` field and the OpenAI-style `choices[0].delta.content`.
 * workers-ai-provider (3.x and 4.0) emits text from both, so every token
 * reaches the chat twice. This wrapper drops the native copy when it matches
 * the OpenAI delta, before the provider parses the stream.
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
        choices?: { delta?: { content?: unknown } }[];
      };
      try {
        event = JSON.parse(data);
      } catch {
        return line;
      }
      const content = event.choices?.[0]?.delta?.content;
      if (typeof content !== "string" || event.response !== content) {
        return line;
      }
      delete event.response;
      return `data: ${JSON.stringify(event)}`;
    })
    .join("\n");
}
