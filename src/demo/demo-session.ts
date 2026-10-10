import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import { resetDemo } from "./reset";
import {
  admitSession,
  emptyDemoState,
  resetSession,
  type DemoState,
  type DemoStatus
} from "./session";
import { DEMO_SQL } from "./sql";

/**
 * One instance coordinates the hosted demo. Decisions use synchronous storage,
 * and a reset blocks admission of every other request until the fresh data is
 * in place, so concurrent first requests reseed once and never read half-reset
 * data. Requests admitted before a reset are not fenced (see docs/deploy.md).
 */
export class DemoSession extends DurableObject<Env> {
  private load(): DemoState {
    return this.ctx.storage.kv.get<DemoState>("state") ?? emptyDemoState();
  }

  async admit(session: string, expires: number): Promise<DemoStatus> {
    const decision = admitSession(this.load(), session, expires, Date.now());
    if (!decision.reset) {
      this.ctx.storage.kv.put("state", decision.state);
      return decision.status;
    }
    // Save inside the block: a queued request must see the new state. A
    // failed reset saves nothing, so the next request tries again.
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.wipe();
      this.ctx.storage.kv.put("state", decision.state);
    });
    return decision.status;
  }

  async reset(): Promise<DemoStatus> {
    return this.ctx.blockConcurrencyWhile(async () => {
      await this.wipe();
      const { state, status } = resetSession(this.load(), Date.now());
      this.ctx.storage.kv.put("state", state);
      return status;
    });
  }

  private async wipe() {
    await resetDemo(this.env, DEMO_SQL, async (customerId) => {
      await (
        await getAgentByName(this.env.BillingAssistant, customerId)
      ).destroy();
    });
  }
}
