import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Reviewed-state for the Dashboard change monitor. A small map of
 * { eventId → reviewedAt ISO } so a "mark reviewed" survives reloads and
 * syncs across devices. Event ids are stable per logical change, so an item
 * re-appears (un-reviewed) only when the underlying fact actually changes.
 *
 * GET  → { reviewed: { [id]: isoTimestamp } }
 * POST → { id: string, reviewed: boolean } toggles one id.
 * Entries older than 60 days are pruned on each write (the source events have
 * long since rolled off the window).
 */

const KEY = "pm:change-monitor-reviewed";
const PRUNE_DAYS = 60;

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    return NextResponse.json({ reviewed: raw ? JSON.parse(raw) : {} });
  } catch {
    return NextResponse.json({ reviewed: {} });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body?.id === "string" ? body.id : "";
    const reviewed = body?.reviewed === true;
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const map: Record<string, string> = raw ? JSON.parse(raw) : {};

    if (reviewed) map[id] = new Date().toISOString();
    else delete map[id];

    // Prune stale entries so the blob stays tiny.
    const cutoff = Date.now() - PRUNE_DAYS * 24 * 60 * 60 * 1000;
    for (const [k, v] of Object.entries(map)) {
      const t = Date.parse(v);
      if (Number.isFinite(t) && t < cutoff) delete map[k];
    }

    await redis.set(KEY, JSON.stringify(map));
    return NextResponse.json({ ok: true, reviewed: !!map[id] });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
  }
}
