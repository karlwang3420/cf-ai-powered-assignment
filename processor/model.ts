/**
 * The mock processor's state model, kept separate from the merchant's billing
 * state. A charge is created by its scenario, then changes only along
 * CHARGE_TRANSITIONS; every change sends a webhook. The processor never reads
 * merchant data: what a change means for the invoice is the merchant's call.
 */
import type {
  ChargeAction,
  ChargeRequest,
  ChargeState,
  DeliveryAction,
  DeliveryState,
  ProcessorCharge,
  ProcessorScenario
} from "../src/payments/protocol.ts";

export type ScenarioPlan = {
  /** State the charge is created in */
  state: ChargeState;
  /** A pending charge the processor itself decides as succeeded, after PENDING_DELAY_MS */
  autoSucceed?: true;
  /** The first POST fails before anything commits; a same-key replay commits */
  outageFirst?: true;
  /** The POST commits, but its response is lost */
  loseResponse?: true;
  /** The charge's first webhook is never sent, or is sent twice */
  firstWebhook?: "dropped" | "twice";
};

/** How each scenario creates its charge. One entry is used per new key. */
export const SCENARIO_PLANS: Record<ProcessorScenario, ScenarioPlan> = {
  success: { state: "succeeded" },
  soft_decline: { state: "soft_decline" },
  hard_decline: { state: "hard_decline" },
  outage: { state: "succeeded", outageFirst: true },
  lost_response: { state: "succeeded", loseResponse: true },
  pending: { state: "pending", autoSucceed: true },
  unresolved_pending: { state: "pending" },
  lost_webhook: { state: "succeeded", firstWebhook: "dropped" },
  duplicate_webhook: { state: "succeeded", firstWebhook: "twice" }
};
export const SCENARIOS = Object.keys(SCENARIO_PLANS) as ProcessorScenario[];

/**
 * Every state change a committed charge can make. Pending is decided once;
 * a decline can still turn into a late success; a success is final.
 */
export const CHARGE_TRANSITIONS: Record<ChargeState, ChargeState[]> = {
  pending: ["succeeded", "soft_decline", "hard_decline"],
  soft_decline: ["succeeded"],
  hard_decline: ["succeeded"],
  succeeded: []
};

/** Deliveries a demo control may send again: never sent, or given up on. */
const REDELIVERABLE: DeliveryState[] = ["dropped", "exhausted"];

export const chargeState = (charge: ProcessorCharge): ChargeState =>
  charge.status === "declined"
    ? `${charge.declineType}_decline`
    : charge.status;

/** The charge in the given state, fields in canonical order. */
export function withState(
  charge: ChargeRequest & { processorPaymentId: string },
  state: ChargeState
): ProcessorCharge {
  const base = {
    invoiceId: charge.invoiceId,
    attemptId: charge.attemptId,
    idempotencyKey: charge.idempotencyKey,
    amountCents: charge.amountCents,
    currency: charge.currency,
    methodVersion: charge.methodVersion,
    processorPaymentId: charge.processorPaymentId
  };
  return state === "soft_decline" || state === "hard_decline"
    ? {
        ...base,
        status: "declined",
        declineType: state === "soft_decline" ? "soft" : "hard"
      }
    : { ...base, status: state };
}

/** Demo controls on a charge: its next states, and a new event for its current one. */
export const chargeActions = (charge: ProcessorCharge | null): ChargeAction[] =>
  charge ? [...CHARGE_TRANSITIONS[chargeState(charge)], "notify"] : [];

export const deliveryActions = (state: DeliveryState): DeliveryAction[] =>
  REDELIVERABLE.includes(state) ? ["deliver"] : [];
