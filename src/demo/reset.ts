import { BillingError } from "../billing/store.ts";
import { processorRequest, type PaymentEnv } from "../payments/service.ts";
import { rebuildDatabase } from "./database.ts";

/** Before the first reset the hosted database has no tables at all. */
async function ids(db: D1Database, sql: string): Promise<string[]> {
  try {
    const { results } = await db.prepare(sql).all<{ id: string }>();
    return results.map((row) => row.id);
  } catch (error) {
    if (String(error).includes("no such table")) return [];
    throw error;
  }
}

/**
 * Agent.destroy() deliberately aborts its isolate after deleting storage. In
 * production that abort can reject the RPC, even though teardown succeeded.
 * Accept only that exact signal, and always verify through a fresh agent.
 */
export async function destroyAndVerifyChat(
  destroy: () => Promise<void>,
  history: () => Promise<unknown>
) {
  try {
    await destroy();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "destroyed") throw error;
  }
  // The scheduled isolate abort can also hit the very next RPC. Reacquire
  // the stub and retry that exact reset signal, with a bounded backoff.
  for (let attempt = 0; ; attempt++) {
    try {
      const messages = await history();
      if (!Array.isArray(messages) || messages.length !== 0)
        throw new Error("chat history was not cleared");
      return;
    } catch (error) {
      if (
        attempt >= 3 ||
        !(error instanceof Error) ||
        error.message !== "destroyed"
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

// Only these states mean the run cannot resume; "unknown" proves nothing
const ENDED = ["complete", "errored", "terminated"];

/**
 * Stops a collection run. Terminating a run that has already ended fails, so
 * a failure is ignored only for such a run; anything else fails the reset.
 * A run that was never created makes get() report it as not found.
 */
async function stopRun(env: PaymentEnv, id: string) {
  let run: WorkflowInstance;
  try {
    run = await env.PAYMENT_WORKFLOW.get(id);
  } catch (error) {
    // A claim whose create call failed points at a run that never existed
    if (/not.?found/i.test(String(error))) return;
    throw error;
  }
  try {
    await run.terminate();
  } catch (error) {
    if (!ENDED.includes((await run.status()).status)) throw error;
  }
}

/**
 * Returns the demo (hosted, or local dev) to its seed: stops collection runs, clears the mock
 * processor, rebuilds D1 and deletes each customer's chat. The processor is
 * cleared before D1 so no old charge can replay or call back into fresh data.
 */
export async function resetDemo(
  env: PaymentEnv,
  scripts: string[],
  clearChat: (customerId: string) => Promise<void>,
  migrations: string[] = []
) {
  const runs = await ids(
    env.DB,
    "SELECT workflow_id AS id FROM payment_collections WHERE owner_active = 1"
  );
  for (const id of runs) await stopRun(env, id);
  const processor = await processorRequest(env, "/demo/reset-all", "POST", {});
  if (!processor.ok)
    throw new BillingError(
      "conflict",
      `processor reset failed (${processor.status}); nothing was changed`
    );
  const before = await ids(env.DB, "SELECT id FROM customers");
  await rebuildDatabase(env.DB, scripts, migrations);
  const customers = [
    ...new Set([...before, ...(await ids(env.DB, "SELECT id FROM customers"))])
  ];
  // Try every chat, then fail if any is left so the whole reset is retried
  const failed: string[] = [];
  for (const id of customers) {
    try {
      await clearChat(id);
    } catch (error) {
      console.error("Demo chat teardown failed", id, error);
      failed.push(id);
    }
  }
  console.log(
    JSON.stringify({
      event: "demo_reset",
      stoppedRuns: runs.length,
      customers: customers.length,
      chatClearFailures: failed
    })
  );
  if (failed.length)
    throw new Error(`could not clear chats for ${failed.join(", ")}`);
  return { stoppedRuns: runs.length, customers };
}
