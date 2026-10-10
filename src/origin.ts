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
 * Browsers open WebSockets to other sites without CORS and with cookies,
 * including a hosted reviewer's Access session. Chat agents therefore refuse
 * cross-site requests, locally and when hosted.
 */
export function refuseCrossSiteAgent(request: Request): Response | null {
  if (!new URL(request.url).pathname.startsWith("/agents/")) return null;
  if (!isCrossSite(request)) return null;
  return Response.json(
    {
      error: {
        code: "forbidden",
        message: "Cross-origin agent requests are not allowed"
      }
    },
    { status: 403 }
  );
}
