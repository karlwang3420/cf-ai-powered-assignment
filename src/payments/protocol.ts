/** Demo-only credentials: public fixtures, never credentials for a real processor. */
export const DEMO_PROCESSOR_TOKEN = "demo-only-processor-token-not-a-secret";
export const DEMO_WEBHOOK_SECRET = "demo-only-webhook-hmac-not-a-secret";
export const PROCESSOR_TIMESTAMP_HEADER = "x-processor-timestamp";
export const PROCESSOR_SIGNATURE_HEADER = "x-processor-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const PROCESSOR_WEBHOOK_PATH = "/api/payments/webhook";
/** The callback goes over a service binding; no public request has this host. */
export const PROCESSOR_CALLBACK_ORIGIN = "https://merchant.internal";

/** This exact payload is persisted by the merchant before the first POST. */
export type ChargeRequest = {
  invoiceId: string;
  attemptId: string;
  idempotencyKey: string;
  amountCents: number;
  currency: "USD";
  methodVersion: number;
};
export type ProcessorCharge = ChargeRequest & {
  processorPaymentId: string;
} & (
    | { status: "pending" | "succeeded" }
    | { status: "declined"; declineType: "soft" | "hard" }
  );
export type ChargeResponse = { charge: ProcessorCharge; replayed: boolean };
export type ChargeStatusResponse = { charge: ProcessorCharge };
export type ProcessorWebhook = {
  eventId: string;
  type: "payment.updated";
  createdAt: string;
  charge: ProcessorCharge;
};
export type ProcessorScenario =
  | "success"
  | "soft_decline"
  | "hard_decline"
  | "outage"
  | "lost_response"
  | "pending"
  | "lost_webhook"
  | "duplicate_webhook"
  | "unresolved_pending";
/** A committed charge's state at the processor. */
export type ChargeState =
  | "pending"
  | "succeeded"
  | "soft_decline"
  | "hard_decline";
/** A webhook delivery's state in the processor's outbox. */
export type DeliveryState = "queued" | "delivered" | "dropped" | "exhausted";
/** Demo control on a charge: change its state, or send a new event for it. */
export type ChargeAction = ChargeState | "notify";
/** Demo control on a delivery: send that same event again. */
export type DeliveryAction = "deliver";

/**
 * The mock processor's whole state for one invoice (GET /demo/inspect),
 * newest first. `actions` lists the demo controls each charge and delivery
 * allows, from the processor's own state model.
 */
export type ProcessorInspection = {
  invoiceId: string;
  keyRetention: "indefinite";
  /** Outcomes queued for the next new charges */
  scenarios: ProcessorScenario[];
  requests: {
    request: ChargeRequest;
    scenario: ProcessorScenario;
    /** Null while an outage has not committed the charge */
    charge: ProcessorCharge | null;
    state: ChargeState | "uncommitted";
    resolveAt: number | null;
    actions: ChargeAction[];
  }[];
  outbox: {
    event: ProcessorWebhook;
    state: DeliveryState;
    attempts: number;
    copiesRemaining: number;
    dueAt: number;
    deliveredAt: number | null;
    lastError: string | null;
    actions: DeliveryAction[];
  }[];
};
export type ProcessorErrorResponse = {
  error: { code: string; message: string };
};

const encoder = new TextEncoder();
async function hmacKey(secret: string, usage: KeyUsage) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage]
  );
}

/** Sign each delivery with a fresh timestamp, but reuse its original event/body. */
export async function signProcessorWebhook(
  rawBody: string,
  secret: string,
  timestampSeconds = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  if (!Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error("Invalid webhook timestamp");
  }
  const timestamp = String(timestampSeconds);
  const digest = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret, "sign"),
    encoder.encode(`${timestamp}.${rawBody}`)
  );
  const hex = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return {
    [PROCESSOR_TIMESTAMP_HEADER]: timestamp,
    [PROCESSOR_SIGNATURE_HEADER]: `v1=${hex}`
  };
}

/** Verify the raw body before JSON parsing. Event-ID deduplication is still required. */
export async function verifyProcessorWebhook(
  rawBody: string,
  headers: Headers,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const timestamp = headers.get(PROCESSOR_TIMESTAMP_HEADER) ?? "";
  const signature = headers.get(PROCESSOR_SIGNATURE_HEADER) ?? "";
  if (
    !/^(0|[1-9]\d{0,12})$/.test(timestamp) ||
    !/^v1=[a-f0-9]{64}$/.test(signature)
  ) {
    return false;
  }
  const seconds = Number(timestamp);
  if (
    !Number.isSafeInteger(nowSeconds) ||
    Math.abs(nowSeconds - seconds) > WEBHOOK_TOLERANCE_SECONDS
  ) {
    return false;
  }
  const bytes = new Uint8Array(
    signature
      .slice(3)
      .match(/../g)!
      .map((hex) => parseInt(hex, 16))
  );
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret, "verify"),
    bytes,
    encoder.encode(`${timestamp}.${rawBody}`)
  );
}

export function isProcessorAuthorized(
  request: Request,
  token: string
): boolean {
  return (
    token.length > 0 &&
    request.headers.get("authorization") === `Bearer ${token}`
  );
}
