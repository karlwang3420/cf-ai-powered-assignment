import { DurableObject } from "cloudflare:workers";
import { Processor } from "./core.ts";
import { isProcessorAuthorized } from "../src/payments/protocol.ts";

export interface ProcessorEnv {
  PROCESSOR_STATE: DurableObjectNamespace<ProcessorState>;
  PROCESSOR_TOKEN: string;
  PROCESSOR_WEBHOOK_SECRET: string;
  MERCHANT?: Fetcher;
}

/** Processor-owned SQLite, never merchant D1 or a chat object's storage. */
export class ProcessorState extends DurableObject<ProcessorEnv> {
  private readonly processor: Processor;
  constructor(ctx: DurableObjectState, env: ProcessorEnv) {
    super(ctx, env);
    this.processor = new Processor(ctx.storage, {
      token: env.PROCESSOR_TOKEN,
      webhookSecret: env.PROCESSOR_WEBHOOK_SECRET,
      merchant: env.MERCHANT
    });
  }
  fetch(request: Request) {
    return this.processor.fetch(request);
  }
  alarm() {
    return this.processor.alarm();
  }
}

export default {
  async fetch(request: Request, env: ProcessorEnv): Promise<Response> {
    if (!isProcessorAuthorized(request, env.PROCESSOR_TOKEN)) {
      return Response.json(
        {
          error: {
            code: "unauthorized",
            message: "Demo processor bearer token required"
          }
        },
        { status: 401 }
      );
    }
    return env.PROCESSOR_STATE.getByName("demo-processor").fetch(request);
  }
} satisfies ExportedHandler<ProcessorEnv>;
