import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { withDedupedStreamText } from "./workers-ai";

// Llama 3.3 on Workers AI, as recommended by the assignment. It supports
// function calling, which the billing tools will use.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `You are a billing support assistant for a usage-based cloud platform.

You help customers and support staff understand usage, invoices, charges, credits, and payments.

Rules:
- Never invent amounts, usage figures, invoices, or account details.
- You do not have access to billing data yet. If asked about a specific account, say that billing lookups are not connected yet.
- You never move money or change billing records yourself.
- Be concise and explain billing concepts plainly.`;

/**
 * One instance per conversation. Its built-in SQLite storage holds only chat
 * history; billing data will live in a shared D1 database as the source of truth.
 */
export class BillingAssistant extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    const workersai = createWorkersAI({
      binding: withDedupedStreamText(this.env.AI)
    });

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system: SYSTEM_PROMPT,
      // Prune old tool calls to stay within the model's 24k-token context window
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      // Workers AI defaults to 256 output tokens, which truncates explanations
      maxOutputTokens: 1024,
      stopWhen: stepCountIs(10),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
