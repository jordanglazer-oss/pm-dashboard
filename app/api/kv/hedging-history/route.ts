import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { mergeHedgingSnapshot } from "@/app/lib/hedging-snapshot";

/**
 * Append-only daily snapshot ledger for SPY hedging costs.
 * One snapshot per day, dated by the day the PRICES are from (the Eastern day
 * of the quotes; before Nov 2026 the UTC capture date). A later reading the
 * same day overwrites; an earlier day is only added when missing, never
 * replaced or deleted.
 */

const KEY = "pm:hedging-history";

export type HedgingSnapshotCustomRow = {
  strike: number;
  quotes: Array<{ expiry: string; premium: number | null }>;
};

export type HedgingSnapshot = {
  date: string; // YYYY-MM-DD the prices are from
  fetchedAt: string; // ISO timestamp
  spotPrice: number;
  quotes: Array<{
    expiry: string;
    atmStrike: number;
    atmPremium: number | null;
    otm5Strike: number;
    otm5Premium: number | null;
    otm10Strike: number;
    otm10Premium: number | null;
  }>;
  /** Optional — captured premiums for any custom strikes in scope at snapshot time. */
  customRows?: HedgingSnapshotCustomRow[];
};

export type HedgingHistory = {
  snapshots: HedgingSnapshot[];
  lastUpdated: string | null;
};

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ snapshots: [], lastUpdated: null });
    return NextResponse.json(JSON.parse(raw));
  } catch (e) {
    console.error("Redis read error (hedging-history):", e);
    return NextResponse.json({ snapshots: [], lastUpdated: null });
  }
}

/**
 * POST: Append (or replace same-day) snapshot.
 * Body: HedgingSnapshot
 */
export async function POST(req: NextRequest) {
  try {
    const snapshot = (await req.json()) as HedgingSnapshot;
    if (!snapshot?.date || !Array.isArray(snapshot.quotes)) {
      return NextResponse.json({ error: "Invalid snapshot payload" }, { status: 400 });
    }

    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const history: HedgingHistory = raw ? JSON.parse(raw) : { snapshots: [], lastUpdated: null };

    // Today's entry can be replaced; an entry for an earlier day is only added when missing.
    const merged = mergeHedgingSnapshot(Array.isArray(history.snapshots) ? history.snapshots : [], snapshot);
    if (!merged.wrote) return NextResponse.json({ ok: true, kept: snapshot.date, totalSnapshots: history.snapshots.length });
    history.snapshots = merged.snapshots;
    history.lastUpdated = new Date().toISOString();

    await redis.set(KEY, JSON.stringify(history));
    return NextResponse.json({ ok: true, totalSnapshots: history.snapshots.length });
  } catch (e) {
    console.error("Redis write error (hedging-history):", e);
    return NextResponse.json({ error: "Failed to save snapshot" }, { status: 500 });
  }
}
