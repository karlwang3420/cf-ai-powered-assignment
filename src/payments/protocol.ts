/** Demo-only credentials: public fixtures, never credentials for a real processor. */
export const DEMO_PROCESSOR_TOKEN = "demo-only-processor-token-not-a-secret";
export const DEMO_WEBHOOK_SECRET = "demo-only-webhook-hmac-not-a-secret";
export const PROCESSOR_TIMESTAMP_HEADER = "x-processor-timestamp";
export const PROCESSOR_SIGNATURE_HEADER = "x-processor-signature";
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const PROCESSOR_WEBHOOK_PATH = "/api/payments/webhook";

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
