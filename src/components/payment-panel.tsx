import { useEffect, useRef, useState } from "react";
import { Badge } from "@cloudflare/kumo";
import type { PaymentCollection } from "../billing/payments";
import { formatCents } from "../billing/pricing";
import { api } from "../client-api";
import {
  customerPaymentLabel,
  dueCents,
  paymentLabel,
  paymentPollDelay,
  paymentTone,
  pollPaymentRead,
  type StatusTone
} from "./payment-state";

/** Polls one customer's payment collections; calls onChanged when they move. */
export function useCustomerPayments(
  customerId: string,
  version: number,
  onChanged: () => void
) {
  const [snapshot, setSnapshot] = useState<{
    customerId: string;
    payments: PaymentCollection[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previous = useRef("");
  useEffect(() => {
    setError(null);
    return pollPaymentRead(
      async () => ({ customerId, payments: await api.payments(customerId) }),
      (next) => {
        const signature = JSON.stringify(next);
        const changed =
          previous.current !== "" && previous.current !== signature;
        previous.current = signature;
        setSnapshot(next);
        setError(null);
        if (changed) onChanged();
      },
      (e) => setError(e.message),
      (next) => paymentPollDelay(next.payments)
    );
  }, [customerId, version, onChanged]);
  return {
    snapshot: snapshot?.customerId === customerId ? snapshot : null,
    error
  };
}

export const toneBadge: Record<
  StatusTone,
  "error" | "success" | "warning" | "secondary"
> = {
  danger: "error",
  success: "success",
  waiting: "warning",
  neutral: "secondary"
};

export function PaymentBadge({
  payment,
  audience = "admin"
}: {
  payment: PaymentCollection;
  audience?: "admin" | "customer";
}) {
  return (
    <Badge variant={toneBadge[paymentTone(payment)]}>
      {audience === "customer"
        ? customerPaymentLabel(payment.status)
        : paymentLabel(payment.status)}
    </Badge>
  );
}

/** Customer view: Paid / Processing / Due, without recovery internals. */
export function CustomerPaymentLine({
  payment
}: {
  payment: PaymentCollection;
}) {
  return (
    <dl className="grid grid-cols-3 gap-2 px-3 pb-3 text-xs">
      {(
        [
          ["Paid", payment.paidCents],
          ["Processing", payment.reservedCents],
          ["Due", dueCents(payment)]
        ] as const
      ).map(([label, cents]) => (
        <div key={label}>
          <dt className="text-kumo-subtle">{label}</dt>
          <dd className="text-kumo-default font-semibold tabular-nums">
            {formatCents(cents)}
          </dd>
        </div>
      ))}
    </dl>
  );
}
