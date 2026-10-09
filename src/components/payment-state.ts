import type {
  CollectionStatus,
  PaymentCollection,
  PaymentInboxEvent
} from "../billing/payments";
import { formatCents } from "../billing/pricing.ts";

export const paymentLabel = (status: string) => status.replaceAll("_", " ");

/** Invoice IDs are `inv_<customer>_<YYYY-MM>` (see billing/store.ts). */
export const invoiceMonth = (invoiceId: string) => invoiceId.slice(-7);

/** Balance not yet held by an in-flight charge; credit + paid + held + due = total. */
export const dueCents = (payment: PaymentCollection) =>
  payment.balanceCents - payment.reservedCents;

export type StatusTone = "danger" | "success" | "waiting" | "neutral";

export function paymentTone(payment: PaymentCollection): StatusTone {
  if (
    payment.hasConflict ||
    payment.status === "needs_review" ||
    payment.status === "past_due"
  )
    return "danger";
  if (payment.status === "paid" || payment.status === "settled")
    return "success";
  if (payment.status === "open") return "neutral";
  return "waiting";
}

/** Customer-facing wording: internal recovery states all read as "Processing". */
export function customerPaymentLabel(status: CollectionStatus): string {
  switch (status) {
    case "paid":
    case "settled":
      return "Paid";
    case "processing":
    case "recovering":
    case "needs_review":
      return "Processing";
    case "retrying":
      return "Retrying";
    case "action_required":
      return "Update card";
    case "past_due":
      return "Past due";
    case "open":
      return "Due";
  }
}

/** One short line describing where the collection loop currently stands. */
export function paymentNextStep(payment: PaymentCollection): string {
  if (payment.hasConflict) return "Conflicting processor results · reconcile";
  switch (payment.status) {
    case "paid":
      return "Paid in full";
    case "settled":
      return "Settled · nothing due";
    case "processing":
      return `Charging attempt ${payment.attemptsUsed}`;
    case "recovering":
      return "Confirming an unknown result";
    case "needs_review":
      return "Result unknown · waiting for the processor";
    case "action_required":
      return "Waiting for a newer card";
    case "retrying":
      return payment.ownerActive ? "Retry scheduled" : "Ready to retry";
    case "past_due":
      return "Out of attempts · balance due";
    case "open":
      return canCollectPayment(payment)
        ? "Ready to collect"
        : (collectBlockedReason(payment) ?? "Open");
  }
}

/** Short reason Collect is disabled, or null when collection is allowed. */
export function collectBlockedReason(
  payment: PaymentCollection
): string | null {
  if (canCollectPayment(payment)) return null;
  if (payment.balanceCents <= 0) return "Nothing due";
  if (payment.hasConflict) return "Conflicting results";
  if (payment.reservedCents > 0)
    return `${formatCents(payment.reservedCents)} held for an unresolved charge`;
  if (payment.ownerActive) return "Collection already running";
  if (payment.status === "needs_review") return "In review";
  if (payment.status === "action_required") return "Needs a newer card";
  return "No attempts left";
}

export function paymentNeedsAttention(payment: PaymentCollection): boolean {
  return Boolean(
    payment.needsAttention || payment.hasConflict || payment.reservedCents > 0
  );
}

export function paymentPollDelay(
  payments: PaymentCollection[],
  inbox: PaymentInboxEvent[] = []
): number {
  return inbox.length > 0 ||
    payments.some(
      (p) =>
        p.ownerActive ||
        p.reservedCents > 0 ||
        ["processing", "retrying", "recovering", "action_required"].includes(
          p.status
        )
    )
    ? 2000
    : 10000;
}

export function canCollectPayment(payment: PaymentCollection): boolean {
  return (
    payment.balanceCents > 0 &&
    payment.attemptsRemaining > 0 &&
    !payment.ownerActive &&
    !payment.hasConflict &&
    payment.reservedCents === 0 &&
    payment.status !== "needs_review" &&
    payment.status !== "action_required"
  );
}

/** One read at a time. Cleanup fences late responses when scope/refresh changes. */
export function pollPaymentRead<T>(
  load: () => Promise<T>,
  receive: (value: T) => void,
  fail: (error: Error) => void,
  delay: (value: T) => number
): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const read = async () => {
    let next = 10000;
    try {
      const value = await load();
      if (stopped) return;
      next = delay(value);
      receive(value);
    } catch (error) {
      if (stopped) return;
      fail(error instanceof Error ? error : new Error("Payment read failed"));
    }
    if (!stopped) timer = setTimeout(read, next);
  };
  void read();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
