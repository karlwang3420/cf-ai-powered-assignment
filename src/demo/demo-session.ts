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
 * One instance coordinates the hosted demo. Decisions use synchronous storage
 * and start a reset before anything else can run, and every request admitted
 * during a reset waits for it, so concurrent first requests reseed once and
 * never read half-reset data. Waiting on a promise rather than
 * blockConcurrencyWhile keeps a slow reset clear of that call's 30-second
 * limit. Requests admitted before a reset are not fenced (see docs/deploy.md).
 */
export class DemoSession extends DurableObject<Env> {
  private resetting: Promise<void> | null = null;

  private load(): DemoState {
    return this.ctx.storage.kv.get<DemoState>("state") ?? emptyDemoState();
  }

  /** Waits out a reset in progress; the caller then decides afresh. */
  private async settled() {
    while (this.resetting) await this.resetting.catch(() => {});
  }

  async admit(session: string, expires: number): Promise<DemoStatus> {
    await this.settled();
    const decision = admitSession(
      this.load(),
      session,
      expires,
      Date.now(),
      this.ctx.storage.kv.get<boolean>(RESET_PENDING) === true
    );
    if (decision.reset) await this.startReset(() => decision.state);
    else this.ctx.storage.kv.put("state", decision.state);
    return decision.status;
  }

  async reset(): Promise<DemoStatus> {
    await this.settled();
    let status: DemoStatus | undefined;
    await this.startReset(() => {
      const next = resetSession(this.load(), Date.now());
      status = next.status;
      return next.state;
    });
    return status!;
  }

  /**
   * Must be called with no await since the decision to reset, so no other
   * request can start a second one. `next` gives the state to save once every
   * stage has succeeded.
   */
  private startReset(next: () => DemoState): Promise<void> {
    const run = (async () => {
      // A reset that stops partway (say, processor cleared but D1 not rebuilt)
      // leaves the stores inconsistent, so every request retries it until done.
      this.ctx.storage.kv.put(RESET_PENDING, true);
      await resetDemo(this.env, DEMO_SQL, async (customerId) => {
        await (
          await getAgentByName(this.env.BillingAssistant, customerId)
        ).destroy();
      });
      this.ctx.storage.kv.put("state", next());
      this.ctx.storage.kv.delete(RESET_PENDING);
    })();
    this.resetting = run;
    return run.finally(() => {
      if (this.resetting === run) this.resetting = null;
    });
  }
}
