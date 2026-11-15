import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { getSnapshotForTicker, setSnapshotForTicker, type AnalystSnapshots, type TickerSnapshot } from "@/app/lib/analyst-snapshots";

const KEY = "pm:analyst-snapshots";

// Force-dynamic ensures the Inbox tab's Coverage Checklist sees fresh
// FactSet target data on every Refresh — without this, Next's default
// route caching could serve a stale snapshot.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ snapshots: {} });
    return NextResponse.json({ snapshots: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (analyst-snapshots):", e);
    return NextResponse.json({ snapshots: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { snapshots } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(snapshots));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (analyst-snapshots):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}

/**
 * PATCH changes ONE ticker, source by source, by read-merge-write:
 *   { ticker, set?: { [source]: value }, remove?: string[] }
 * Everything else in the blob — other tickers, and this ticker's other
 * sources — is left exactly as stored. The browser uses this for every edit,
 * so a tab left open can no longer roll back what the nightly estimates
 * refresh or the email ingest wrote since it loaded.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = (await req.json()) as { ticker?: unknown; set?: unknown; remove?: unknown };
    const ticker = typeof body.ticker === "string" ? body.ticker.trim() : "";
    const set = body.set && typeof body.set === "object" && !Array.isArray(body.set) ? (body.set as Record<string, unknown>) : {};
    const remove = Array.isArray(body.remove) ? body.remove.filter((x): x is string => typeof x === "string") : [];
    if (!ticker || (Object.keys(set).length === 0 && remove.length === 0)) {
      return NextResponse.json({ error: "ticker plus set or remove required" }, { status: 400 });
    }
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    // An unreadable blob throws here and nothing is written.
    const blob = (raw ? JSON.parse(raw) : {}) as AnalystSnapshots;
    const current = { ...(getSnapshotForTicker(blob, ticker) ?? {}) } as Record<string, unknown>;
    for (const [source, value] of Object.entries(set)) current[source] = value;
    for (const source of remove) delete current[source];
    const next = setSnapshotForTicker(blob, ticker, Object.keys(current).length ? (current as TickerSnapshot) : undefined);
    await redis.set(KEY, JSON.stringify(next));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis patch error (analyst-snapshots):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
