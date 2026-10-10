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

const RESET_PENDING = "resetPending";

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
    const decision = admitSession(
      this.load(),
      session,
      expires,
      Date.now(),
      this.ctx.storage.kv.get<boolean>(RESET_PENDING) === true
    );
    if (!decision.reset) {
      this.ctx.storage.kv.put("state", decision.state);
      return decision.status;
    }
    // Save inside the block: a queued request must see the new state. A
    // failed reset saves nothing, so the next request tries again.
    await this.exclusive(async () => {
      await this.wipe();
      this.ctx.storage.kv.put("state", decision.state);
    });
    return decision.status;
  }

  async reset(): Promise<DemoStatus> {
    return this.exclusive(async () => {
      await this.wipe();
      const { state, status } = resetSession(this.load(), Date.now());
      this.ctx.storage.kv.put("state", state);
      return status;
    });
  }

  /**
   * Runs a reset with every other request held back. A failure is rethrown
   * outside the block: one thrown inside would reset this object and could
   * lose the reset-pending mark.
   */
  private async exclusive<T>(body: () => Promise<T>): Promise<T> {
    const outcome = await this.ctx.blockConcurrencyWhile(async () => {
      try {
        return { ok: true as const, value: await body() };
      } catch (error) {
        return { ok: false as const, error };
      }
    });
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  private async wipe() {
    // A reset that stops partway (say, processor cleared but D1 not rebuilt)
    // leaves the stores inconsistent, so every request retries it until done.
    this.ctx.storage.kv.put(RESET_PENDING, true);
    await resetDemo(this.env, DEMO_SQL, async (customerId) => {
      await (
        await getAgentByName(this.env.BillingAssistant, customerId)
      ).destroy();
    });
    this.ctx.storage.kv.delete(RESET_PENDING);
  }
}
