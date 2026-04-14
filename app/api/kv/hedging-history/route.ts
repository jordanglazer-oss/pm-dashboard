import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Append-only daily snapshot ledger for SPY hedging costs.
 * One snapshot per UTC date — later snapshots on the same day overwrite.
 * Never deletes or modifies prior days.
 */

const KEY = "pm:hedging-history";

export type HedgingSnapshot = {
  date: string; // YYYY-MM-DD (capture date, UTC)
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

    // Replace same-day snapshot, else append
    const idx = history.snapshots.findIndex((s) => s.date === snapshot.date);
    if (idx >= 0) {
      history.snapshots[idx] = snapshot;
    } else {
      history.snapshots.push(snapshot);
      history.snapshots.sort((a, b) => a.date.localeCompare(b.date));
    }
    history.lastUpdated = new Date().toISOString();

    await redis.set(KEY, JSON.stringify(history));
    return NextResponse.json({ ok: true, totalSnapshots: history.snapshots.length });
  } catch (e) {
    console.error("Redis write error (hedging-history):", e);
    return NextResponse.json({ error: "Failed to save snapshot" }, { status: 500 });
  }
}
