import {
  getPaymentCollection,
  listPaymentCollections,
  listPaymentInbox,
  updatePaymentMethod
} from "../billing/payments.ts";
import { BillingError, getCustomer } from "../billing/store.ts";
import {
  methodEventType,
  paymentLog,
  processorRequest,
  receiveWebhook,
  debugResetCollection,
  reconcilePaymentCollections,
  startCollection,
  type PaymentEnv
} from "./service.ts";

async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new BillingError("invalid", "request body must be a JSON object");
  }
}

/** Payment routes are exact so nested paths cannot fall through to legacy invoice reads. */
export async function handlePaymentApi(
  request: Request,
  env: PaymentEnv
): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname.split("/").slice(2).map(decodeURIComponent);
  if (path[0] !== "payments") return null;
  const action = path[1];
  if (path.length === 2 && request.method === "GET" && action === "inbox") {
    const scopes = url.searchParams.getAll("customerId");
    // Admin console reads every customer's unapplied events; it must opt in explicitly.
    if (url.searchParams.get("all") === "true" && scopes.length === 0)
      return Response.json(await listPaymentInbox(env.DB));
    const customerId = scopes[0];
    if (scopes.length !== 1 || !customerId?.trim() || customerId.length > 500)
      throw new BillingError("invalid", "one non-empty customerId is required");
    await getCustomer(env.DB, customerId);
    const invoiceIds = new Set(
      (await listPaymentCollections(env.DB, customerId)).map((c) => c.invoiceId)
    );
    return Response.json(
      (await listPaymentInbox(env.DB)).filter((event) =>
        invoiceIds.has(event.outcome.invoiceId)
      )
    );
  }
  if (path.length === 2 && request.method === "POST" && action === "webhook")
    return receiveWebhook(request, env);
  if (path.length === 1 && request.method === "GET") {
    const collections = await listPaymentCollections(
      env.DB,
      url.searchParams.get("customerId") ?? undefined
    );
    return Response.json(
      url.searchParams.get("needsAttention") === "true"
        ? collections.filter((c) => c.needsAttention)
        : collections
    );
  }
  if (
    path.length === 2 &&
    request.method === "POST" &&
    action === "reconcile"
  ) {
    const body = await bodyOf(request);
    if (
      (body.invoiceId !== undefined &&
        (typeof body.invoiceId !== "string" ||
          !body.invoiceId.trim() ||
          body.invoiceId.length > 500)) ||
      (body.resume !== undefined && typeof body.resume !== "boolean")
    )
      throw new BillingError(
        "invalid",
        "invoiceId must be a string; resume must be boolean"
      );
    return Response.json(
      await reconcilePaymentCollections(
        env,
        body.invoiceId as string | undefined,
        body.resume === true
      )
    );
  }
  if (path.length === 2 && request.method === "POST" && action === "method") {
    const body = await bodyOf(request);
    if (
      typeof body.customerId !== "string" ||
      !Number.isSafeInteger(body.expectedVersion) ||
      Number(body.expectedVersion) < 1
    )
      throw new BillingError(
        "invalid",
        "customerId and positive expectedVersion are required"
      );
    const version = await updatePaymentMethod(
      env.DB,
      body.customerId,
      body.expectedVersion as number
    );
    for (const c of await listPaymentCollections(env.DB, body.customerId)) {
      if (!c.ownerActive || !c.workflowId) continue;
      try {
        await (
          await env.PAYMENT_WORKFLOW.get(c.workflowId)
        ).sendEvent({
          type: methodEventType,
          payload: { customerId: body.customerId, version }
        });
      } catch {
        paymentLog("method_notification_failed", {
          invoiceId: c.invoiceId,
          workflowInstanceId: c.workflowId
        });
      }
    }
    return Response.json({
      customerId: body.customerId,
      methodVersion: version
    });
  }
  if (path.length === 2 && request.method === "GET")
    return Response.json(await getPaymentCollection(env.DB, action));
  if (path.length === 3) {
    const invoiceId = action;
    await getPaymentCollection(env.DB, invoiceId);
    if (request.method === "POST" && path[2] === "collect")
      return Response.json(await startCollection(env, invoiceId), {
        status: 202
      });
    if (request.method === "POST" && path[2] === "debug-reset")
      return Response.json(await debugResetCollection(env, invoiceId));
    if (request.method === "GET" && path[2] === "timeline")
      return Response.json(
        (await getPaymentCollection(env.DB, invoiceId)).timeline
      );
    if (request.method === "GET" && path[2] === "processor")
      return processorRequest(
        env,
        `/demo/inspect?invoiceId=${encodeURIComponent(invoiceId)}`
      );
    if (request.method === "POST" && path[2] === "settle") {
      const body = await bodyOf(request);
      return processorRequest(env, "/demo/settle", "POST", {
        invoiceId,
        outcome: body.outcome
      });
    }
    if (request.method === "PUT" && path[2] === "scenarios") {
      const body = await bodyOf(request);
      return processorRequest(env, "/demo/scenarios", "PUT", {
        invoiceId,
        scenarios: body.scenarios
      });
    }
    if (request.method === "GET" && path[2] === "run") {
      const c = await getPaymentCollection(env.DB, invoiceId);
      if (!c.workflowId)
        return Response.json({ id: null, status: "not_started" });
      try {
        const { status, output, error } = await (
          await env.PAYMENT_WORKFLOW.get(c.workflowId)
        ).status();
        return Response.json({ id: c.workflowId, status, output, error });
      } catch {
        return Response.json({ id: c.workflowId, status: "unavailable" });
      }
    }
  }
  return Response.json(
    { error: { code: "not_found", message: "unknown payment route" } },
    { status: 404 }
  );
}
