/**
 * Verifies the Cloudflare Access token (`Cf-Access-Jwt-Assertion`) that Access
 * attaches to every request it lets through. Checking it in the Worker means a
 * missing or misconfigured Access application fails closed instead of open.
 */
export type AccessClaims = {
  sub?: string;
  email?: string;
  common_name?: string;
  iat: number;
  exp: number;
};

type AccessOptions = {
  teamDomain: string;
  aud: string;
  now?: number;
  fetcher?: typeof fetch;
};

const KEY_TTL_MS = 60 * 60_000;
const keyCache = new Map<
  string,
  { keys: Map<string, CryptoKey>; expires: number }
>();

/** `team.cloudflareaccess.com`; an explicit scheme is kept for local tests. */
export const teamOrigin = (teamDomain: string) => {
  const domain = teamDomain.replace(/\/+$/, "");
  return /^https?:\/\//.test(domain) ? domain : `https://${domain}`;
};

function decode(part: string): Uint8Array<ArrayBuffer> {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(
    atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=")),
    (c) => c.charCodeAt(0)
  );
}

const json = (part: string) =>
  JSON.parse(new TextDecoder().decode(decode(part))) as Record<string, unknown>;

async function signingKeys(
  origin: string,
  fetcher: typeof fetch,
  now: number,
  refresh: boolean
) {
  const cached = keyCache.get(origin);
  if (cached && cached.expires > now && !refresh) return cached.keys;
  const response = await fetcher(`${origin}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access certs ${response.status}`);
  const { keys } = (await response.json()) as {
    keys: (JsonWebKey & { kid: string })[];
  };
  const imported = new Map<string, CryptoKey>();
  for (const jwk of keys)
    imported.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"]
      )
    );
  keyCache.set(origin, { keys: imported, expires: now + KEY_TTL_MS });
  return imported;
}

/** Returns the token's claims, or null if it is not valid for this app. */
export async function verifyAccessJwt(
  token: string,
  { teamDomain, aud, now = Date.now(), fetcher = fetch }: AccessOptions
): Promise<AccessClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let claims: Record<string, unknown>;
  try {
    header = json(parts[0]);
    claims = json(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string") return null;
  const origin = teamOrigin(teamDomain);
  // Access rotates keys; an unknown key ID refreshes the cache once.
  let key = (await signingKeys(origin, fetcher, now, false)).get(header.kid);
  key ??= (await signingKeys(origin, fetcher, now, true)).get(header.kid);
  if (!key) return null;
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decode(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  );
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const seconds = now / 1000;
  if (
    !valid ||
    !audiences.includes(aud) ||
    claims.iss !== origin ||
    typeof claims.iat !== "number" ||
    typeof claims.exp !== "number" ||
    claims.exp <= seconds ||
    (typeof claims.nbf === "number" && claims.nbf > seconds + 60)
  )
    return null;
  return claims as AccessClaims;
}

/** One Access login; a new login issues a new token with a new `iat`. */
export const accessSession = (claims: AccessClaims) =>
  `${claims.sub || claims.email || claims.common_name || "unknown"}:${claims.iat}`;
