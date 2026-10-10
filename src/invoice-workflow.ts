import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  BillingError,
  finalizeInvoice,
  openInvoice,
  reconcile
} from "./billing/store.ts";

export type InvoiceRunParams = { customerId: string; month: string };

export type InvoiceRunResult = {
  invoiceId: string;
  totalCents: number | null;
  reconciliationIssues: number;
};

const RETRIES = {
  retries: { limit: 3, delay: "2 seconds", backoff: "exponential" }
} as const;

/** Retrying cannot fix bad input, so stop the run instead. */
async function failFast<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof BillingError &&
      ["invalid", "not_found", "period_open"].includes(error.code)
    ) {
      throw new NonRetryableError(error.message);
    }
    throw error;
  }
}

/**
 * Invoices one customer for one month. Each step is retried on failure and
 * its result is persisted, so a crashed run resumes where it stopped. The
 * billing operations are idempotent, so a step that runs twice is harmless.
 * Payment collection is a separate admin action, so a mock processor outcome
 * can be chosen for the finalized invoice before anything is charged.
 */
export class InvoiceWorkflow extends WorkflowEntrypoint<Env, InvoiceRunParams> {
  async run(
    event: WorkflowEvent<InvoiceRunParams>,
    step: WorkflowStep
  ): Promise<InvoiceRunResult> {
    const { customerId, month } = event.payload;
    const db = this.env.DB;

    // Closes the month to new usage, so the next step prices a fixed set
    const draft = await step.do("open draft invoice", RETRIES, () =>
      failFast(() => openInvoice(db, customerId, month))
    );
    const invoice = await step.do("finalize invoice", RETRIES, () =>
      finalizeInvoice(db, draft.id)
    );
    const issues = await step.do("reconcile ledger", RETRIES, () =>
      reconcile(db)
    );
    if (issues.length > 0) {
      // The invoice is already final; surface the problem for investigation
      console.error(
        "Reconciliation issues after invoicing",
        invoice.id,
        issues
      );
    }
    return {
      invoiceId: invoice.id,
      totalCents: invoice.totalCents,
      reconciliationIssues: issues.length
    };
  }
}
