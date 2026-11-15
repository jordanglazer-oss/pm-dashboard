import { SignJWT, jwtVerify } from "jose";

/**
 * Signed login cookie.
 *
 * The cookie used to be the fixed text "authenticated", so anyone who set
 * that value by hand passed the gate without the password. It is now a token
 * signed with a key derived from the site password (or AUTH_SECRET when set),
 * so it can only be minted by the login route and cannot be forged.
 *
 * Changing SITE_PASSWORD (or AUTH_SECRET) invalidates every existing session.
 * Runs in both the edge middleware and Node route handlers (Web Crypto only).
 * No Redis access.
 */

export const AUTH_COOKIE = "auth";
export const AUTH_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 days

let cachedKey: { secret: string; key: Uint8Array } | null = null;

async function signingKey(): Promise<Uint8Array | null> {
  const secret = process.env.AUTH_SECRET || process.env.SITE_PASSWORD;
  if (!secret) return null;
  if (cachedKey?.secret === secret) return cachedKey.key;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`pm-dashboard-auth-v1:${secret}`),
  );
  const key = new Uint8Array(digest);
  cachedKey = { secret, key };
  return key;
}

/** Mint a session token. Null when no secret is configured (fail closed). */
export async function issueAuthToken(): Promise<string | null> {
  const key = await signingKey();
  if (!key) return null;
  return new SignJWT({ scope: "pm-dashboard" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${AUTH_MAX_AGE_SEC}s`)
    .sign(key);
}

/** True only for a token this app signed that has not expired. */
export async function verifyAuthToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const key = await signingKey();
  if (!key) return false;
  try {
    const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
    return payload.scope === "pm-dashboard";
  } catch {
    return false;
  }
}

export function authCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: AUTH_MAX_AGE_SEC,
    path: "/",
  };
}
