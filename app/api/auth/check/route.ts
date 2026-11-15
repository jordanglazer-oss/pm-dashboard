import { NextRequest, NextResponse } from "next/server";
import { AUTH_COOKIE, authCookieOptions, issueAuthToken, verifyAuthToken } from "@/app/lib/auth-token";

export async function GET(req: NextRequest) {
  if (await verifyAuthToken(req.cookies.get(AUTH_COOKIE)?.value)) {
    // Sliding session: each visit renews the 30 days, so a device in regular
    // use is not sent back to the login page on a fixed date.
    const res = NextResponse.json({ ok: true });
    const fresh = await issueAuthToken();
    if (fresh) res.cookies.set(AUTH_COOKIE, fresh, authCookieOptions());
    return res;
  }
  return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
}
