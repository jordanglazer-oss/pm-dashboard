import { getRedis } from "@/app/lib/redis";
import { computeChangeEvents, type ChangeEvent } from "@/app/lib/change-monitor";
import { SIA_HISTORY_KEY, type SiaHistoryStore } from "@/app/lib/sia-history";
import type { Stock } from "@/app/lib/types";
import type { ScoreHistoryStore } from "@/app/api/kv/score-history/route";
import type { AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import { RESEARCH_REMOVALS_KEY, type ResearchRemovalStore } from "@/app/lib/research-removals";
import type { ResearchState } from "@/app/lib/defaults";

/**
 * Change-monitor input assembly, extracted from /api/change-monitor so the
 * daily summary can compute the same event list server-side without an HTTP
 * hop. Read-mostly: the only write is the rolling price baseline
 * (pm:change-monitor-pricebase, a pure cache) — identical to the route.
 */

/** RemovalSource → the ResearchState field holding that list's current entries. */
const SOURCE_TO_FIELD: Record<string, keyof ResearchState> = {
  "fundstrat-top": "fundstratTop",
  "fundstrat-bottom": "fundstratBottom",
  "fundstrat-smid-top": "fundstratSmidTop",
  "fundstrat-smid-bottom": "fundstratSmidBottom",
  "rbc-focus": "rbcCanadianFocus",
  "rbc-us-focus": "rbcUsFocus",
  "jpm-us-analyst-focus": "jpmUsAnalystFocus",
  "rbc-equate-cad": "equateCad",
  "rbc-equate-usd": "equateUsd",
  "seeking-alpha-picks": "alphaPicks",
  "rbccm-few": "rbccmFew",
  "newton-upticks": "newtonUpticks",
};

export const PRICEBASE_KEY = "pm:change-monitor-pricebase";

export type PriceBase = { takenAt: string; prices: Record<string, number> };

async function readJson<T>(redis: Awaited<ReturnType<typeof getRedis>>, key: string, fallback: T): Promise<T> {
  try {
    const raw = await redis.get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function loadChangeEvents(windowDays: number, nowMs: number = Date.now()): Promise<ChangeEvent[]> {
  const redis = await getRedis();
  const [scoreHistory, stocks, snapshots, base, researchRemovals, research, siaHistory] = await Promise.all([
    readJson<ScoreHistoryStore>(redis, "pm:score-history", {}),
    readJson<{ stocks?: Stock[] } | Stock[]>(redis, "pm:stocks", []),
    readJson<AnalystSnapshots>(redis, "pm:analyst-snapshots", {}),
    readJson<PriceBase | null>(redis, PRICEBASE_KEY, null),
    readJson<ResearchRemovalStore>(redis, RESEARCH_REMOVALS_KEY, {}),
    readJson<ResearchState | null>(redis, "pm:research", null),
    readJson<SiaHistoryStore>(redis, SIA_HISTORY_KEY, {}),
  ]);
  const stockList: Stock[] = Array.isArray(stocks) ? stocks : (stocks.stocks ?? []);

  // Build the current-tickers set per research source so a removal that's
  // since been re-added (e.g. a name only on the 2nd screenshot of a
  // multi-part list) doesn't surface as a phantom "dropped" event.
  const researchCurrentTickers: Record<string, Set<string>> = {};
  if (research) {
    for (const [source, field] of Object.entries(SOURCE_TO_FIELD)) {
      const list = research[field];
      if (Array.isArray(list)) {
        researchCurrentTickers[source] = new Set(
          list
            .map((e) => (e && typeof e === "object" && "ticker" in e ? String((e as { ticker?: unknown }).ticker || "") : ""))
            .filter(Boolean)
            .map((t) => t.toUpperCase())
        );
      }
    }
  }

  const events = computeChangeEvents({
    scoreHistory,
    stocks: stockList,
    snapshots,
    priceBaseline: base?.prices ?? {},
    researchRemovals,
    researchCurrentTickers,
    siaHistory,
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

  return events;
}
