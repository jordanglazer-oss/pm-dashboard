import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

// Rate limit: 10 password attempts per minute per IP. Generous enough for
// legitimate typos, tight enough to make brute-forcing the site password
// impractical. Uses Redis so the limit is consistent across serverless
// invocations (in-memory wouldn't survive a cold start).
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SEC = 60;

async function checkRateLimit(ip: string): Promise<boolean> {
  try {
    const redis = await getRedis();
    const key = `pm:ratelimit:auth:${ip}`;
    // INCR + EXPIRE (first-call) is the standard fixed-window pattern.
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, RATE_LIMIT_WINDOW_SEC);
    }
    return count <= RATE_LIMIT_MAX;
  } catch {
    // If Redis is down, fail open — we'd rather let users log in than
    // lock everyone out because of a rate-limit bookkeeping failure.
    return true;
  }
}

function clientIp(req: NextRequest): string {
  // Vercel sets x-forwarded-for; fall back to "unknown" if absent.
  const fwd = req.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

export async function POST(req: NextRequest) {
  const ip = clientIp(req);
  const allowed = await checkRateLimit(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: "Too many attempts. Try again in a minute." },
      { status: 429 },
    );
  }

  const { password } = await req.json();
  const sitePassword = process.env.SITE_PASSWORD;

  if (!sitePassword) {
    return NextResponse.json({ error: "SITE_PASSWORD not configured" }, { status: 500 });
  }

  if (password === sitePassword) {
    const res = NextResponse.json({ ok: true });
    res.cookies.set("auth", "authenticated", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30, // 30 days
      path: "/",
    });
    return res;
  }

  return NextResponse.json({ error: "Wrong password" }, { status: 401 });
}
