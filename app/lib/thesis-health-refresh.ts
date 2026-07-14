import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { computeThesisHealth, verdictRank, type ThesisHealth } from "@/app/lib/thesis-health";

/**
 * Thesis-health rebuild, extracted from /api/thesis-health so BOTH the route
 * AND the nightly cron can run it. The cron needs it because pm:thesis-health
 * is a 6h cache that only ever refreshed on a page load — at 06:00 UTC nobody
 * is on the dashboard, so the alert digest was computing thesis alerts off a
 * verdict set that could be a day old.
 *
 * Inputs are all READ-ONLY (pm:stocks, pm:score-history, pm:analyst-snapshots);
 * the only write is pm:thesis-health, a regenerable cache. Cheap — no external
 * calls, so it's safe to run inline in the cron.
 */

const log = createLogger("ThesisHealth");

export const THESIS_KEY = "pm:thesis-health";
export const THESIS_STALE_MS = 6 * 60 * 60 * 1000;

type StoredStock = {
  ticker?: string;
  name?: string;
  sector?: string;
  bucket?: string;
  riskAlert?: { level?: string };
};

export type ThesisHealthStore = {
  builtAt: string;
  counts: { broken: number; eroding: number; intact: number };
  holdings: Array<ThesisHealth & { name?: string; sector?: string }>;
};

export async function readThesisCache(): Promise<(ThesisHealthStore & { builtAt?: string }) | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(THESIS_KEY);
    return raw ? (JSON.parse(raw) as ThesisHealthStore) : null;
  } catch (e) {
    log.warn("cache read failed:", e instanceof Error ? e.message : e);
    return null;
  }
}

/** Recompute every Portfolio holding's thesis verdict and persist the cache. */
export async function rebuildThesisHealth(): Promise<ThesisHealthStore> {
  const redis = await getRedis();
  const [stocksRaw, scoreRaw, snapsRaw] = await Promise.all([
    redis.get("pm:stocks"),
    redis.get("pm:score-history"),
    redis.get("pm:analyst-snapshots"),
  ]);

  const stocks: StoredStock[] = (() => {
    try {
      const p = stocksRaw ? JSON.parse(stocksRaw) : [];
      return Array.isArray(p) ? p : [];
    } catch {
      return [];
    }
  })();
  const scoreHistory: Record<string, Array<{ date: string; total: number }>> = (() => {
    try {
      return scoreRaw ? JSON.parse(scoreRaw) : {};
    } catch {
      return {};
    }
  })();
  const snaps: Record<string, { factset?: { revUp?: number; revDown?: number } }> = (() => {
    try {
      return snapsRaw ? JSON.parse(snapsRaw) : {};
    } catch {
      return {};
    }
  })();

  const port = stocks.filter((s) => s.bucket === "Portfolio" && s.ticker);
  const results: Array<ThesisHealth & { name?: string; sector?: string }> = [];
  for (const s of port) {
    const ticker = s.ticker!.toUpperCase();
    const fs = snaps[ticker]?.factset ?? snaps[s.ticker!]?.factset;
    const net =
      fs && (typeof fs.revUp === "number" || typeof fs.revDown === "number")
        ? (fs.revUp ?? 0) - (fs.revDown ?? 0)
        : null;
    const health = computeThesisHealth({
      ticker,
      scoreHistory: scoreHistory[ticker] ?? scoreHistory[s.ticker!],
      netRevisions: net,
      riskLevel: s.riskAlert?.level ?? null,
    });
    results.push({ ...health, name: s.name, sector: s.sector });
  }

  results.sort((a, b) => verdictRank(a.verdict) - verdictRank(b.verdict) || a.ticker.localeCompare(b.ticker));

  const thesisHealth: ThesisHealthStore = {
    builtAt: new Date().toISOString(),
    counts: {
      broken: results.filter((r) => r.verdict === "broken").length,
      eroding: results.filter((r) => r.verdict === "eroding").length,
      intact: results.filter((r) => r.verdict === "intact").length,
    },
    holdings: results,
  };

  try {
    await redis.set(THESIS_KEY, JSON.stringify(thesisHealth));
  } catch (e) {
    log.warn("cache write failed:", e instanceof Error ? e.message : e);
  }
  return thesisHealth;
}
