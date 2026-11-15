import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { HEDGES_KEY, type HedgePosition } from "@/app/lib/hedges";

/**
 * Active hedge-position ledger (pm:hedges). GET returns the full list. POST
 * MERGES by id: every row in the body is added or replaces the stored row with
 * that id, and stored rows the body does not carry are KEPT. The ledger only
 * grows (a close is a status change on the same id; nothing deletes a row), so
 * a tab whose load failed, or one opened before another device logged a hedge,
 * can no longer erase rows. The Brief sends just the row it changed. Returns []
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

/** POST adds / updates rows by id and returns the full ledger. Body: { hedges: HedgePosition[] } */
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
    let stored: HedgePosition[] = [];
    const raw = await redis.get(HEDGES_KEY);
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        stored = Array.isArray(parsed?.hedges) ? parsed.hedges : Array.isArray(parsed) ? parsed : [];
      } catch {
        // Unreadable ledger: refuse rather than write over it.
        return NextResponse.json({ error: "Stored hedge ledger could not be read; nothing was saved" }, { status: 500 });
      }
    }
    const incoming = new Map(clean.map((h) => [h.id, h]));
    const merged: HedgePosition[] = stored.map((h) => incoming.get(h.id) ?? h);
    const storedIds = new Set(stored.map((h) => h.id));
    for (const h of clean) if (!storedIds.has(h.id)) merged.push(h);

    await redis.set(HEDGES_KEY, JSON.stringify({ hedges: merged }));
    return NextResponse.json({ ok: true, hedges: merged });
  } catch (e) {
    console.error("Redis write error (hedges):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
