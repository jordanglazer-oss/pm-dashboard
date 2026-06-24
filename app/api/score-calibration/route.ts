import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { computeCalibration, type PriceMap, type CalibrationResult } from "@/app/lib/score-calibration";
import type { ScoreHistoryStore } from "@/app/api/kv/score-history/route";

/**
 * GET /api/score-calibration?horizon=91[&refresh=1]
 *
 * "Does the score work?" — joins pm:score-history to realized forward returns
 * and groups by rating bucket. Expensive (one Yahoo daily-history fetch per
 * ticker + the benchmark), so the result is cached in pm:score-calibration
 * and only recomputed on ?refresh=1 or when older than 24h. Pure cache (no
 * user data touched) — safe to nuke.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_KEY = "pm:score-calibration";
const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const BENCHMARK = "SPY";

function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

/** date(YYYY-MM-DD) → adjusted close, over `range`. Empty map on failure. */
async function fetchDailyCloses(ticker: string, range = "1y"): Promise<PriceMap> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(toYahoo(ticker))}?range=${range}&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return {};
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const ts: number[] = result?.timestamp || [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
    const map: PriceMap = {};
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (typeof c === "number" && c > 0) map[new Date(ts[i] * 1000).toISOString().slice(0, 10)] = c;
    }
    return map;
  } catch {
    return {};
  }
}

async function inChunks<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const horizonDays = Math.max(7, Math.min(365, parseInt(sp.get("horizon") || "91", 10) || 91));
  const refresh = sp.get("refresh") === "1";
  const nowMs = Date.now();

  const redis = await getRedis();

  if (!refresh) {
    try {
      const raw = await redis.get(CACHE_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { generatedAt: string; horizonDays: number; result: CalibrationResult };
        const ageMs = nowMs - Date.parse(cached.generatedAt);
        if (cached.horizonDays === horizonDays && Number.isFinite(ageMs) && ageMs < 24 * 60 * 60 * 1000) {
          return NextResponse.json({ ...cached, cached: true });
        }
      }
    } catch { /* fall through to recompute */ }
  }

  try {
    const histRaw = await redis.get("pm:score-history");
    const scoreHistory: ScoreHistoryStore = histRaw ? JSON.parse(histRaw) : {};
    const tickers = Object.keys(scoreHistory);
    if (tickers.length === 0) {
      const empty: CalibrationResult = { horizonDays, totalObservations: 0, buckets: [], categories: [], headline: { buyHitRate: null, strongBuyAvg: null, sellAvg: null, buyMinusSell: null } };
      return NextResponse.json({ generatedAt: new Date(nowMs).toISOString(), horizonDays, result: empty, cached: false, note: "No score history yet." });
    }

    const prices: Record<string, PriceMap> = {};
    const maps = await inChunks(tickers, 6, async (t) => [t.toUpperCase(), await fetchDailyCloses(t)] as const);
    for (const [t, m] of maps) prices[t] = m;
    const benchmark = await fetchDailyCloses(BENCHMARK);

    const result = computeCalibration({ scoreHistory, prices, benchmark, horizonDays, nowMs });
    const payload = { generatedAt: new Date(nowMs).toISOString(), horizonDays, result };
    try { await redis.set(CACHE_KEY, JSON.stringify(payload)); } catch { /* cache only */ }
    return NextResponse.json({ ...payload, cached: false });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 200 });
  }
}
