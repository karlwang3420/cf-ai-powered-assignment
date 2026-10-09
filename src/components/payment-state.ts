import type { PaymentCollection, PaymentInboxEvent } from "../billing/payments";

export const paymentLabel = (status: string) => status.replaceAll("_", " ");

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
