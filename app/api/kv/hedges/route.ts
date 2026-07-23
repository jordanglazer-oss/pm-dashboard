import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { HEDGES_KEY, type HedgePosition } from "@/app/lib/hedges";

/**
 * Active hedge-position ledger (pm:hedges). GET returns the full list; POST
 * replaces it (the client manages add/close/edit locally, then persists the
 * whole array — same pattern as the other single-user KV stores). Returns []
 * on a missing key, never seeds defaults.
 */

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(HEDGES_KEY);
    if (!raw) return NextResponse.json({ hedges: [] });
    const parsed = JSON.parse(raw);
    const hedges = Array.isArray(parsed?.hedges) ? parsed.hedges : Array.isArray(parsed) ? parsed : [];
    return NextResponse.json({ hedges });
  } catch (e) {
    console.error("Redis read error (hedges):", e);
    return NextResponse.json({ hedges: [] });
  }
}

/** POST replaces the entire ledger. Body: { hedges: HedgePosition[] } */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { hedges?: HedgePosition[] };
    if (!Array.isArray(body?.hedges)) {
      return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
    }
    // Sanitize: keep only well-formed rows with a stable id + valid status.
    const clean: HedgePosition[] = body.hedges
      .filter((h) => h && typeof h.id === "string" && (h.status === "active" || h.status === "closed"))
      .map((h) => ({
        ...h,
        implementedAt: typeof h.implementedAt === "string" ? h.implementedAt : new Date().toISOString(),
      }));

    const redis = await getRedis();
    await redis.set(HEDGES_KEY, JSON.stringify({ hedges: clean }));
    return NextResponse.json({ ok: true, hedges: clean });
  } catch (e) {
    console.error("Redis write error (hedges):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
