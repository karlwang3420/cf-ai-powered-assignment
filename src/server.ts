import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  convertToModelMessages,
  createUIMessageStream,
  createUIMessageStreamResponse,
  isToolUIPart,
  pruneMessages,
  stepCountIs,
  streamText
} from "ai";
import { handleApi } from "./api";
import { createBillingTools } from "./assistant-tools";
import { BillingError, getCustomer } from "./billing/store";
import { withDedupedStreamText } from "./workers-ai";

export { InvoiceWorkflow } from "./invoice-workflow";

// Llama 3.3 on Workers AI, as recommended by the assignment. It supports
// function calling, which the billing tools use.
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

function systemPrompt(customer: string, today: string) {
  return `You are a billing support assistant for a usage-based cloud platform.
You are helping ${customer}. Today is ${today} (UTC). Months are written YYYY-MM.

Billing data comes only from your tools, which only see this customer's account.
Pricing: each plan has a monthly fee plus usage charges for Workers requests and Workers AI neurons. Each meter has a free monthly allowance; usage above it is charged per block.

Rules:
- Call tools before answering anything about this account. Never invent or estimate amounts, usage, dates, or invoices.
- Quote figures exactly as tools return them. Do not do arithmetic yourself; use compareMonths for changes between months and getDailyUsage to find spikes.
- To explain a bill, name the specific line items or usage changes that caused it.
- Only call issueCredit when the user asks for a credit. It runs only after a support person approves it. If it returns a result, the credit was approved and applied: say so. If it was rejected or failed, say it was not applied.
- If a tool returns an error, explain it plainly.
- Be concise.`;
}

/**
 * One chat per customer: the agent instance name is the customer id. Its
 * built-in SQLite storage holds only chat history; billing data lives in the
 * shared D1 database, reached through customer-scoped tools.
 */
export class BillingAssistant extends AIChatAgent<Env> {
  maxPersistedMessages = 100;
  chatRecovery = true;

  async onChatMessage(_onFinish: unknown, options?: OnChatMessageOptions) {
    // A rejected credit is a human decision: confirm it without the model,
    // which tends to misread a denied tool call (Llama 3.3 replies as if it
    // cannot use tools at all).
    const lastPart = this.messages.at(-1)?.parts.at(-1);
    if (
      lastPart &&
      isToolUIPart(lastPart) &&
      lastPart.state === "output-denied"
    ) {
      return fixedReply(
        "The credit was rejected, so nothing was applied to the invoice."
      );
    }

    const customerId = this.name;
    let customerName: string;
    try {
      customerName = `${(await getCustomer(this.env.DB, customerId)).name} (customer ${customerId})`;
    } catch (error) {
      if (!(error instanceof BillingError)) throw error;
      customerName = `an unknown customer "${customerId}"; tell the user no billing account was found`;
    }

    // After a failed credit, Llama tends to propose the same credit again;
    // withhold the tool for this turn so it explains the error instead.
    const creditJustFailed =
      lastPart !== undefined &&
      isToolUIPart(lastPart) &&
      lastPart.type === "tool-issueCredit" &&
      lastPart.state === "output-error";
    const tools = createBillingTools(this.env.DB, customerId);

    const workersai = createWorkersAI({
      binding: withDedupedStreamText(this.env.AI)
    });

    const result = streamText({
      model: workersai(MODEL, { sessionAffinity: this.sessionAffinity }),
      system: systemPrompt(customerName, new Date().toISOString().slice(0, 10)),
      // Prune old tool calls to stay within the model's 24k-token context window
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages"
      }),
      tools,
      activeTools: creditJustFailed
        ? (Object.keys(tools).filter(
            (name) => name !== "issueCredit"
          ) as (keyof typeof tools)[])
        : undefined,
      // Deterministic answers suit billing questions
      temperature: 0,
      // Workers AI defaults to 256 output tokens, which truncates explanations
      maxOutputTokens: 1024,
      stopWhen: stepCountIs(8),
      abortSignal: options?.abortSignal
    });

    return result.toUIMessageStreamResponse({
      // The SDK hides error details from the client; keep them in the logs
      onError: (error) => {
        // Billing errors are expected outcomes (e.g. a credit over the limit)
        if (error instanceof BillingError) return error.message;
        console.error("Chat stream error:", error);
        return "Something went wrong while answering. Please try again.";
      }
    });
  }
}

function fixedReply(text: string) {
  return createUIMessageStreamResponse({
    stream: createUIMessageStream({
      execute: ({ writer }) => {
        writer.write({ type: "text-start", id: "fixed" });
        writer.write({ type: "text-delta", id: "fixed", delta: text });
        writer.write({ type: "text-end", id: "fixed" });
      }
    })
  });
}

export default {
  async fetch(request: Request, env: Env) {
    return (
      (await handleApi(request, env)) ??
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
