import { NextRequest, NextResponse } from "next/server";

// ── API auth gate ─────────────────────────────────────────────────────────
// Rejects any unauthenticated request to /api/* with 401 before it reaches
// a route handler. Closes the hole where client-side AuthGate protected the
// UI but API routes (which read/write Redis) were open to the public
// internet. Login endpoints are exempted so the login flow still works;
// everything else requires the "auth" cookie set by /api/auth.
//
// No Redis reads/writes happen here — the middleware only inspects the
// cookie. Logged-in browsers already send the cookie automatically
// (same-origin), so existing functionality is unaffected.

const AUTH_COOKIE = "auth";
const AUTH_COOKIE_VALUE = "authenticated";

// Paths that must stay open so a user who is NOT logged in can still log in.
// Everything else under /api/* requires the auth cookie.
const PUBLIC_API_PATHS = new Set<string>([
  "/api/auth",        // POST to submit password
  "/api/auth/check",  // GET to see if already logged in
]);

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  // Only gate /api/* routes. Everything else (pages, static files) is
  // already handled by the client-side AuthGate component.
  if (!pathname.startsWith("/api/")) {
    return NextResponse.next();
  }

  // Login / check endpoints must remain accessible.
  if (PUBLIC_API_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  // Vercel cron runner has no auth cookie — it authenticates via the
  // `Authorization: Bearer $CRON_SECRET` header, which the route itself
  // verifies. Exempt the whole /api/cron/* namespace from the cookie gate.
  if (pathname.startsWith("/api/cron/")) {
    return NextResponse.next();
  }

  // All other API routes require the auth cookie.
  const cookie = req.cookies.get(AUTH_COOKIE);
  if (cookie?.value === AUTH_COOKIE_VALUE) {
    return NextResponse.next();
  }

  return NextResponse.json(
    { error: "Unauthorized" },
    { status: 401 },
  );
}

// Run this middleware on every request. The guard above short-circuits
// for non-API paths so the cost is a single startsWith check.
export const config = {
  matcher: "/:path*",
};
