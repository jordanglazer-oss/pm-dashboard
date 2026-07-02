import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { computeChangeEvents } from "@/app/lib/change-monitor";
import type { Stock } from "@/app/lib/types";
import type { ScoreHistoryStore } from "@/app/api/kv/score-history/route";
import type { AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import { RESEARCH_REMOVALS_KEY, type ResearchRemovalStore } from "@/app/lib/research-removals";

/**
 * GET /api/change-monitor?window=7
 *
 * Returns the typed "what changed" event list for the Dashboard change
 * monitor. Read-mostly: the only write is maintaining a small rolling price
 * baseline (pm:change-monitor-pricebase, a pure cache) so price moves can be
 * measured "since ~last week" without an external history fetch.
 */

export const dynamic = "force-dynamic";

const PRICEBASE_KEY = "pm:change-monitor-pricebase";

type PriceBase = { takenAt: string; prices: Record<string, number> };

async function readJson<T>(redis: Awaited<ReturnType<typeof getRedis>>, key: string, fallback: T): Promise<T> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function GET(req: NextRequest) {
  const windowDays = Math.max(1, Math.min(90, parseInt(new URL(req.url).searchParams.get("window") || "7", 10) || 7));
  const nowMs = Date.now();
  try {
    const redis = await getRedis();
    const [scoreHistory, stocks, snapshots, base, researchRemovals] = await Promise.all([
      readJson<ScoreHistoryStore>(redis, "pm:score-history", {}),
      readJson<{ stocks?: Stock[] } | Stock[]>(redis, "pm:stocks", []),
      readJson<AnalystSnapshots>(redis, "pm:analyst-snapshots", {}),
      readJson<PriceBase | null>(redis, PRICEBASE_KEY, null),
      readJson<ResearchRemovalStore>(redis, RESEARCH_REMOVALS_KEY, {}),
    ]);
    const stockList: Stock[] = Array.isArray(stocks) ? stocks : (stocks.stocks ?? []);

    const events = computeChangeEvents({
      scoreHistory,
      stocks: stockList,
      snapshots,
      priceBaseline: base?.prices ?? {},
      researchRemovals,
      windowDays,
      nowMs,
    });

    // Roll the price baseline forward when it's missing or older than the
    // window, so the next comparison spans ~one fresh window. Current prices
    // come from pm:stocks (kept fresh by the nav Refresh). Pure cache write.
    const baseAgeMs = base ? nowMs - Date.parse(base.takenAt) : Infinity;
    if (!base || !Number.isFinite(Date.parse(base.takenAt)) || baseAgeMs >= windowDays * 24 * 60 * 60 * 1000) {
      const prices: Record<string, number> = {};
      for (const s of stockList) {
        if (typeof s.price === "number" && s.price > 0) prices[s.ticker.toUpperCase()] = s.price;
      }
      try { await redis.set(PRICEBASE_KEY, JSON.stringify({ takenAt: new Date(nowMs).toISOString(), prices } satisfies PriceBase)); } catch { /* cache only */ }
    }

    return NextResponse.json({ generatedAt: new Date(nowMs).toISOString(), windowDays, count: events.length, events });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed", events: [] }, { status: 200 });
  }
}
