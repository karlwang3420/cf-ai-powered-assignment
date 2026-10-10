/**
 * A browser request from another site. Browsers send Origin on cross-site
 * POSTs and on every WebSocket upgrade; Sec-Fetch-Site covers requests that
 * omit it. CLI and service-binding calls send neither.
 */
export function isCrossSite(request: Request): boolean {
  const origin = request.headers.get("Origin");
  return origin !== null
    ? origin !== new URL(request.url).origin
    : request.headers.get("Sec-Fetch-Site") === "cross-site";
}

/**
 * Browsers send cookies, including a hosted reviewer's Access session, with
 * cross-site WebSockets and simple requests, without CORS. The API and chat
 * agents therefore refuse cross-site requests before anything else runs, so
 * another site cannot chat, mutate, or keep the shared demo from resetting.
 */
export function refuseCrossSite(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/agents/"))
    return null;
  if (!isCrossSite(request)) return null;
  return Response.json(
    {
      error: {
        code: "forbidden",
        message: "Cross-origin requests are not allowed"
      }
    },
    { status: 403 }
  );
}
