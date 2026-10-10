import {
  PROCESSOR_CALLBACK_ORIGIN,
  PROCESSOR_WEBHOOK_PATH
} from "../payments/protocol.ts";
import { accessSession, verifyAccessJwt } from "./access.ts";
import type { DemoSession } from "./demo-session";
import type { DemoStatus } from "./session.ts";

export type DemoEnv = {
  DEMO_ACCESS_TEAM_DOMAIN?: string;
  DEMO_ACCESS_AUD?: string;
  DEMO_SESSION?: DurableObjectNamespace<DemoSession>;
};

const forbidden = (message: string, status = 403) =>
  Response.json({ error: { code: "forbidden", message } }, { status });

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Hosted demo mode is on when both Access variables are set (local dev leaves
 * them empty). Every API and chat request must then carry a valid Access
 * token, and its session may reseed the shared demo before it is served.
 * Without them only loopback is served, so a plain deploy fails closed.
 * Returns a refusal, the demo status, or null to serve the request as is.
 */
export async function admitDemoRequest(
  request: Request,
  env: DemoEnv,
  verify = verifyAccessJwt
): Promise<Response | DemoStatus | null> {
  const teamDomain = env.DEMO_ACCESS_TEAM_DOMAIN;
  const aud = env.DEMO_ACCESS_AUD;
  const { hostname, origin, pathname } = new URL(request.url);
  if (!pathname.startsWith("/api/") && !pathname.startsWith("/agents/"))
    return null;
  // The processor's HMAC-signed callback arrives over the service binding,
  // under an internal hostname; the same path from the Internet needs Access.
  if (
    request.method === "POST" &&
    pathname === PROCESSOR_WEBHOOK_PATH &&
    origin === PROCESSOR_CALLBACK_ORIGIN
  )
    return null;
  if (!teamDomain && !aud)
    return LOOPBACK.has(hostname)
      ? null
      : forbidden("Deploy with npm run deploy:demo to use Access", 503);
  if (!teamDomain || !aud || !env.DEMO_SESSION)
    return forbidden("Demo access is misconfigured", 503);
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  let claims;
  try {
    claims = token ? await verify(token, { teamDomain, aud }) : null;
  } catch (error) {
    console.error("Access verification failed", error);
    return forbidden("Could not verify the Access sign-in", 503);
  }
  if (!claims) return forbidden("Sign in through Cloudflare Access");
  return env.DEMO_SESSION.getByName("demo").admit(
    accessSession(claims),
    claims.exp * 1000
  );
}
