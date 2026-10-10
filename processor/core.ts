import {
  isProcessorAuthorized,
  PROCESSOR_WEBHOOK_PATH,
  signProcessorWebhook
} from "../src/payments/protocol.ts";
import type {
  ChargeRequest,
  ProcessorCharge,
  ProcessorScenario,
  ProcessorWebhook
} from "../src/payments/protocol.ts";

/** Structural adapter keeps the business logic runnable against fresh Node SQLite. */
export interface ProcessorStorage {
  sql: {
    exec<T extends Record<string, SqlStorageValue>>(
      query: string,
      ...bindings: (string | number | null)[]
    ): { toArray(): T[] };
  };
  transactionSync<T>(body: () => T): T;
  setAlarm(time: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}
export interface ProcessorOptions {
  token: string;
  webhookSecret: string;
  merchant?: { fetch(request: Request): Promise<Response> };
  now?: () => number;
}

type KeyRow = {
  idempotency_key: string;
  attempt_id: string;
  invoice_id: string;
  request_json: string;
  scenario: ProcessorScenario;
  payment_id: string | null;
  outcome_json: string | null;
  resolve_at: number | null;
  created_at: number;
};
type OutboxRow = {
  event_id: string;
  invoice_id: string;
  payment_id: string;
  raw_body: string;
  state: "queued" | "delivered" | "dropped" | "exhausted";
  attempts: number;
  copies_remaining: number;
  due_at: number;
  delivered_at: number | null;
  last_error: string | null;
};
export const PENDING_DELAY_MS = 2_000;
export const MAX_DELIVERY_ATTEMPTS = 8;
const DELIVERY_LEASE_MS = 30_000;
const SETTLE_OUTCOMES = ["succeeded", "soft_decline", "hard_decline"] as const;
type SettleOutcome = (typeof SETTLE_OUTCOMES)[number];
const SCENARIOS: ProcessorScenario[] = [
  "success",
  "soft_decline",
  "hard_decline",
  "outage",
  "lost_response",
  "pending",
  "lost_webhook",
  "duplicate_webhook",
  "unresolved_pending"
];
class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
function invalid(message: string): never {
  throw new HttpError(400, "invalid_request", message);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("Expected an object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]) {
  if (Object.keys(value).some((key) => !names.includes(key)))
    invalid("Unknown field");
}
function identity(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 200 ||
    value.trim() !== value ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    })
  ) {
    invalid(`${name} must be a nonempty identifier of at most 200 characters`);
  }
  return value;
}
function chargeRequest(input: unknown): ChargeRequest {
  const value = object(input);
  fields(value, [
    "invoiceId",
    "attemptId",
    "idempotencyKey",
    "amountCents",
    "currency",
    "methodVersion"
  ]);
  if (
    !Number.isSafeInteger(value.amountCents) ||
    (value.amountCents as number) <= 0
  )
    invalid("amountCents must be positive integer cents");
  if (
    !Number.isSafeInteger(value.methodVersion) ||
    (value.methodVersion as number) < 1
  )
    invalid("methodVersion must be a positive integer");
  if (value.currency !== "USD") invalid("Only USD is supported by this demo");
  // Explicit field order canonicalizes semantically identical JSON requests.
  return {
    invoiceId: identity(value.invoiceId, "invoiceId"),
    attemptId: identity(value.attemptId, "attemptId"),
    idempotencyKey: identity(value.idempotencyKey, "idempotencyKey"),
    amountCents: value.amountCents as number,
    currency: "USD",
    methodVersion: value.methodVersion as number
  };
}
async function body(request: Request): Promise<unknown> {
  if (
    !(request.headers.get("content-type") ?? "")
      .toLowerCase()
      .startsWith("application/json")
  ) {
    throw new HttpError(415, "invalid_content_type", "Use application/json");
  }
  const reader = request.body?.getReader();
  if (!reader) invalid("Missing JSON body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > 16_384) {
      await reader.cancel();
      throw new HttpError(413, "body_too_large", "Body limit is 16 KiB");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    invalid("Invalid JSON");
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "cache-control": "no-store" }
  });

export class Processor {
  private readonly now: () => number;
  private readonly storage: ProcessorStorage;
  private readonly options: ProcessorOptions;
  constructor(storage: ProcessorStorage, options: ProcessorOptions) {
    this.storage = storage;
    this.options = options;
    this.now = options.now ?? Date.now;
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS processor_keys (
      idempotency_key TEXT PRIMARY KEY, attempt_id TEXT NOT NULL UNIQUE,
      invoice_id TEXT NOT NULL, request_json TEXT NOT NULL, scenario TEXT NOT NULL,
      payment_id TEXT UNIQUE, outcome_json TEXT, resolve_at INTEGER, created_at INTEGER NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS processor_scenarios (
      invoice_id TEXT PRIMARY KEY, queue_json TEXT NOT NULL
    )`);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS processor_outbox (
      event_id TEXT PRIMARY KEY, invoice_id TEXT NOT NULL, payment_id TEXT NOT NULL,
      raw_body TEXT NOT NULL, state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      copies_remaining INTEGER NOT NULL, due_at INTEGER NOT NULL,
      delivered_at INTEGER, last_error TEXT
    )`);
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS processor_outbox_due ON processor_outbox(state, due_at)"
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS processor_pending_due ON processor_keys(resolve_at)"
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS processor_keys_invoice ON processor_keys(invoice_id, created_at)"
    );
    storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS processor_outbox_invoice ON processor_outbox(invoice_id, due_at)"
    );
  }
  private rows<T extends Record<string, SqlStorageValue>>(
    query: string,
    ...bindings: (string | number | null)[]
  ): T[] {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }
  private key(key: string) {
    return this.rows<KeyRow>(
      "SELECT * FROM processor_keys WHERE idempotency_key = ?",
      key
    )[0];
  }
  private enqueue(charge: ProcessorCharge, scenario: ProcessorScenario) {
    const event: ProcessorWebhook = {
      eventId: `evt_${crypto.randomUUID()}`,
      type: "payment.updated",
      createdAt: new Date(this.now()).toISOString(),
      charge
    };
    this.storage.sql.exec(
      `INSERT INTO processor_outbox
      (event_id, invoice_id, payment_id, raw_body, state, copies_remaining, due_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      event.eventId,
      charge.invoiceId,
      charge.processorPaymentId,
      JSON.stringify(event),
      scenario === "lost_webhook" ? "dropped" : "queued",
      scenario === "duplicate_webhook" ? 2 : 1,
      this.now()
    );
  }
  private consumeScenario(invoiceId: string): ProcessorScenario {
    const row = this.rows<{ queue_json: string }>(
      "SELECT queue_json FROM processor_scenarios WHERE invoice_id = ?",
      invoiceId
    )[0];
    const queue: ProcessorScenario[] = row ? JSON.parse(row.queue_json) : [];
    const scenario = queue.shift() ?? "success";
    if (queue.length) {
      this.storage.sql.exec(
        "UPDATE processor_scenarios SET queue_json = ? WHERE invoice_id = ?",
        JSON.stringify(queue),
        invoiceId
      );
    } else {
      this.storage.sql.exec(
        "DELETE FROM processor_scenarios WHERE invoice_id = ?",
        invoiceId
      );
    }
    return scenario;
  }
  private create(request: ChargeRequest): Response {
    return this.storage.transactionSync(() => {
      const canonical = JSON.stringify(request);
      let existing = this.key(request.idempotencyKey);
      if (existing && existing.request_json !== canonical) {
        throw new HttpError(
          409,
          "idempotency_conflict",
          "Key is bound to another immutable payload"
        );
      }
      if (existing?.outcome_json) {
        return json({
          charge: JSON.parse(existing.outcome_json),
          replayed: true
        });
      }
      if (!existing) {
        if (
          this.rows(
            "SELECT attempt_id FROM processor_keys WHERE attempt_id = ?",
            request.attemptId
          ).length
        ) {
          throw new HttpError(
            409,
            "attempt_conflict",
            "Attempt is already bound to another key"
          );
        }
        const scenario = this.consumeScenario(request.invoiceId);
        this.storage.sql.exec(
          `INSERT INTO processor_keys
          (idempotency_key, attempt_id, invoice_id, request_json, scenario, created_at)
          VALUES (?, ?, ?, ?, ?, ?)`,
          request.idempotencyKey,
          request.attemptId,
          request.invoiceId,
          canonical,
          scenario,
          this.now()
        );
        existing = this.key(request.idempotencyKey)!;
        if (scenario === "outage") {
          return json(
            {
              error: {
                code: "processor_unavailable",
                message:
                  "Demo transient outage; replay this exact key and payload"
              }
            },
            503
          );
        }
      }
      const scenario = existing.scenario;
      const base = {
        ...request,
        processorPaymentId: `pay_${crypto.randomUUID()}`
      };
      const charge: ProcessorCharge =
        scenario === "soft_decline" || scenario === "hard_decline"
          ? {
              ...base,
              status: "declined",
              declineType: scenario === "soft_decline" ? "soft" : "hard"
            }
          : {
              ...base,
              status:
                scenario === "pending" || scenario === "unresolved_pending"
                  ? "pending"
                  : "succeeded"
            };
      this.storage.sql.exec(
        `UPDATE processor_keys SET payment_id = ?, outcome_json = ?, resolve_at = ?
        WHERE idempotency_key = ?`,
        charge.processorPaymentId,
        JSON.stringify(charge),
        scenario === "pending" ? this.now() + PENDING_DELAY_MS : null,
        request.idempotencyKey
      );
      this.enqueue(charge, scenario);
      if (scenario === "lost_response") {
        // Commit success and its outbox atomically, but withhold the charge response.
        return json(
          {
            error: {
              code: "response_lost",
              message: "Demo response lost; outcome unknown to caller"
            }
          },
          504
        );
      }
      return json({ charge, replayed: false }, 201);
    });
  }
  /** Both alarms and status/replay observations can advance due pending outcomes. */
  private progress() {
    this.storage.transactionSync(() => {
      const rows = this.rows<KeyRow>(
        "SELECT * FROM processor_keys WHERE resolve_at <= ? ORDER BY resolve_at LIMIT 32",
        this.now()
      );
      for (const row of rows) {
        const previous: ProcessorCharge = JSON.parse(row.outcome_json!);
        if (previous.status !== "pending")
          throw new Error("Invalid pending transition");
        const charge: ProcessorCharge = { ...previous, status: "succeeded" };
        this.storage.sql.exec(
          "UPDATE processor_keys SET outcome_json = ?, resolve_at = NULL WHERE idempotency_key = ?",
          JSON.stringify(charge),
          row.idempotency_key
        );
        this.enqueue(charge, row.scenario);
      }
    });
  }
  /** Arm before mutation/network I/O: a crash cannot strand a committed outbox row. */
  private arm() {
    return this.storage.setAlarm(this.now() + 1_000);
  }
  private async schedule() {
    const next = this.rows<{
      due: number | null;
    }>(`SELECT MIN(due) AS due FROM (
      SELECT MIN(resolve_at) AS due FROM processor_keys WHERE resolve_at IS NOT NULL
      UNION ALL SELECT MIN(due_at) AS due FROM processor_outbox WHERE state = 'queued'
    )`)[0]?.due;
    if (next === null || next === undefined) await this.storage.deleteAlarm();
    else await this.storage.setAlarm(Math.max(this.now() + 50, next));
  }
  async fetch(request: Request): Promise<Response> {
    if (!isProcessorAuthorized(request, this.options.token)) {
      return json(
        {
          error: {
            code: "unauthorized",
            message: "Demo processor bearer token required"
          }
        },
        401
      );
    }
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      if (request.method === "POST" && path === "/charges") {
        const payload = chargeRequest(await body(request));
        await this.arm();
        this.progress();
        const response = this.create(payload);
        await this.schedule();
        return response;
      }
      if (
        request.method === "GET" &&
        (path === "/charges" || /^\/charges\/[^/]+$/.test(path))
      ) {
        await this.arm();
        this.progress();
        let row: KeyRow | undefined;
        if (path === "/charges") {
          row = this.key(
            identity(url.searchParams.get("idempotencyKey"), "idempotencyKey")
          );
        } else {
          row = this.rows<KeyRow>(
            "SELECT * FROM processor_keys WHERE payment_id = ?",
            decodeURIComponent(path.slice("/charges/".length))
          )[0];
        }
        await this.schedule();
        if (!row)
          throw new HttpError(
            404,
            "not_found",
            "No charge found; not proof of a decline"
          );
        if (!row.outcome_json)
          throw new HttpError(
            503,
            "processor_unavailable",
            "Charge has not committed; replay original request"
          );
        return json({ charge: JSON.parse(row.outcome_json) });
      }
      if (request.method === "PUT" && path === "/demo/scenarios") {
        const value = object(await body(request));
        fields(value, ["invoiceId", "scenarios"]);
        const invoiceId = identity(value.invoiceId, "invoiceId");
        if (
          !Array.isArray(value.scenarios) ||
          value.scenarios.length > 20 ||
          value.scenarios.some((item) => !SCENARIOS.includes(item))
        )
          invalid("scenarios must contain at most 20 named scenarios");
        this.storage.sql.exec(
          `INSERT INTO processor_scenarios VALUES (?, ?)
          ON CONFLICT(invoice_id) DO UPDATE SET queue_json = excluded.queue_json`,
          invoiceId,
          JSON.stringify(value.scenarios)
        );
        return json({ invoiceId, scenarios: value.scenarios });
      }
      if (request.method === "POST" && path === "/demo/settle") {
        // Demo control: the processor finally decides this invoice's pending
        // charge. The merchant learns it only via the normal signed webhook
        // or a status lookup; nothing on the merchant side is forced.
        const value = object(await body(request));
        fields(value, ["invoiceId", "outcome"]);
        const invoiceId = identity(value.invoiceId, "invoiceId");
        const outcome = value.outcome;
        if (!SETTLE_OUTCOMES.includes(outcome as SettleOutcome))
          invalid("outcome must be succeeded, soft_decline or hard_decline");
        await this.arm();
        const charge = this.storage.transactionSync(() => {
          const row = this.rows<KeyRow>(
            `SELECT * FROM processor_keys WHERE invoice_id = ?
            AND json_extract(outcome_json, '$.status') = 'pending'
            ORDER BY created_at DESC, rowid DESC LIMIT 1`,
            invoiceId
          )[0];
          if (!row)
            throw new HttpError(
              409,
              "not_pending",
              "No pending charge for this invoice"
            );
          const previous: ProcessorCharge = JSON.parse(row.outcome_json!);
          const next: ProcessorCharge =
            outcome === "succeeded"
              ? { ...previous, status: "succeeded" }
              : {
                  ...previous,
                  status: "declined",
                  declineType: outcome === "soft_decline" ? "soft" : "hard"
                };
          this.storage.sql.exec(
            "UPDATE processor_keys SET outcome_json = ?, resolve_at = NULL WHERE idempotency_key = ?",
            JSON.stringify(next),
            row.idempotency_key
          );
          this.enqueue(next, row.scenario);
          return next;
        });
        await this.schedule();
        return json({ invoiceId, charge });
      }
      if (request.method === "POST" && path === "/demo/reset") {
        // Local debug reset: forget this invoice's keys, deliveries and queue so
        // a fresh attempt 1 cannot replay the old charge.
        const value = object(await body(request));
        fields(value, ["invoiceId"]);
        const invoiceId = identity(value.invoiceId, "invoiceId");
        for (const table of [
          "processor_keys",
          "processor_outbox",
          "processor_scenarios"
        ])
          this.storage.sql.exec(
            `DELETE FROM ${table} WHERE invoice_id = ?`,
            invoiceId
          );
        return json({ invoiceId, reset: true });
      }
      if (request.method === "POST" && path === "/demo/reset-all") {
        // Hosted demo reset: forget every key, delivery and queued scenario so
        // nothing replays or calls back into the reseeded merchant database.
        for (const table of [
          "processor_keys",
          "processor_outbox",
          "processor_scenarios"
        ])
          this.storage.sql.exec(`DELETE FROM ${table}`);
        await this.storage.deleteAlarm();
        return json({ reset: true });
      }
      if (request.method === "GET" && path === "/demo/inspect") {
        const invoiceId = identity(
          url.searchParams.get("invoiceId"),
          "invoiceId"
        );
        const plans = this.rows<KeyRow>(
          "SELECT * FROM processor_keys WHERE invoice_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 50",
          invoiceId
        );
        const outbox = this.rows<OutboxRow>(
          "SELECT * FROM processor_outbox WHERE invoice_id = ? ORDER BY rowid DESC LIMIT 100",
          invoiceId
        );
        const queue = this.rows<{ queue_json: string }>(
          "SELECT queue_json FROM processor_scenarios WHERE invoice_id = ?",
          invoiceId
        )[0];
        return json({
          invoiceId,
          keyRetention: "indefinite",
          scenarios: queue ? JSON.parse(queue.queue_json) : [],
          requests: plans.map((row) => ({
            request: JSON.parse(row.request_json),
            scenario: row.scenario,
            charge: row.outcome_json ? JSON.parse(row.outcome_json) : null,
            resolveAt: row.resolve_at
          })),
          outbox: outbox.map((row) => ({
            event: JSON.parse(row.raw_body),
            state: row.state,
            attempts: row.attempts,
            copiesRemaining: row.copies_remaining,
            dueAt: row.due_at,
            deliveredAt: row.delivered_at,
            lastError: row.last_error
          }))
        });
      }
      if (request.method === "POST" && path === "/demo/outbox/retry") {
        const value = object(await body(request));
        fields(value, ["eventId"]);
        const eventId = identity(value.eventId, "eventId");
        await this.arm();
        const row = this.rows<OutboxRow>(
          "SELECT * FROM processor_outbox WHERE event_id = ?",
          eventId
        )[0];
        if (!row) throw new HttpError(404, "not_found", "Unknown event");
        if (row.state !== "exhausted")
          throw new HttpError(
            409,
            "not_exhausted",
            "Only exhausted deliveries can be resumed"
          );
        this.storage.sql.exec(
          "UPDATE processor_outbox SET state = 'queued', attempts = 0, due_at = ?, last_error = NULL WHERE event_id = ?",
          this.now(),
          eventId
        );
        await this.schedule();
        return json({ eventId, state: "queued" });
      }
      throw new HttpError(404, "not_found", "Unknown processor endpoint");
    } catch (error) {
      if (error instanceof HttpError)
        return json(
          { error: { code: error.code, message: error.message } },
          error.status
        );
      if (error instanceof URIError)
        return json(
          {
            error: { code: "invalid_request", message: "Invalid URL encoding" }
          },
          400
        );
      throw error;
    }
  }
  async alarm(): Promise<void> {
    await this.arm();
    this.progress();
    // Each alarm does bounded work. Leases recover a crash while awaiting callback.
    for (let count = 0; count < 16; count++) {
      const row = this.rows<OutboxRow>(
        "SELECT * FROM processor_outbox WHERE state = 'queued' AND due_at <= ? ORDER BY due_at, rowid LIMIT 1",
        this.now()
      )[0];
      if (!row) break;
      if (row.attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.storage.sql.exec(
          "UPDATE processor_outbox SET state = 'exhausted', last_error = 'Delivery budget exhausted' WHERE event_id = ?",
          row.event_id
        );
        continue;
      }
      const attempt = row.attempts + 1;
      this.storage.sql.exec(
        "UPDATE processor_outbox SET attempts = ?, due_at = ? WHERE event_id = ?",
        attempt,
        this.now() + DELIVERY_LEASE_MS,
        row.event_id
      );
      try {
        if (!this.options.merchant)
          throw new Error("MERCHANT service binding is unavailable");
        const signature = await signProcessorWebhook(
          row.raw_body,
          this.options.webhookSecret,
          Math.floor(this.now() / 1000)
        );
        const response = await this.options.merchant.fetch(
          new Request(`https://merchant.internal${PROCESSOR_WEBHOOK_PATH}`, {
            method: "POST",
            headers: { "content-type": "application/json", ...signature },
            body: row.raw_body,
            redirect: "manual",
            signal: AbortSignal.timeout(5_000)
          })
        );
        // Only 2xx acknowledges durable receipt. Redirects are not acknowledgements.
        await response.body?.cancel();
        if (!response.ok) throw new Error(`Merchant HTTP ${response.status}`);
        const remaining = row.copies_remaining - 1;
        this.storage.sql.exec(
          `UPDATE processor_outbox SET state = ?, copies_remaining = ?, delivered_at = ?,
          due_at = ?, last_error = NULL WHERE event_id = ? AND attempts = ? AND state = 'queued'`,
          remaining ? "queued" : "delivered",
          remaining,
          this.now(),
          this.now() + 100,
          row.event_id,
          attempt
        );
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message.slice(0, 300)
            : "Delivery failed";
        const delay = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
        this.storage.sql.exec(
          `UPDATE processor_outbox SET state = ?, due_at = ?, last_error = ?
          WHERE event_id = ? AND attempts = ? AND state = 'queued'`,
          attempt >= MAX_DELIVERY_ATTEMPTS ? "exhausted" : "queued",
          this.now() + delay,
          message,
          row.event_id,
          attempt
        );
      }
    }
    await this.schedule();
  }
}
