import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep
} from "cloudflare:workers";
import type { CollectionOwner } from "./billing/payments.ts";
import { runPaymentCollection } from "./payments/collection.ts";

export class PaymentWorkflow extends WorkflowEntrypoint<Env, CollectionOwner> {
  async run(event: WorkflowEvent<CollectionOwner>, step: WorkflowStep) {
    if (event.instanceId !== event.payload.workflowId)
      throw new Error("Payment Workflow identity mismatch");
    return runPaymentCollection(this.env, event.payload, step);
  }
}
