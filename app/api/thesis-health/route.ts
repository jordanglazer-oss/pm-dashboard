import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { computeThesisHealth, verdictRank, type ThesisHealth } from "@/app/lib/thesis-health";

/**
 * GET /api/thesis-health — automated per-holding thesis verdicts (Phase 03).
 *
 * Reads pm:stocks (Portfolio names + risk level), pm:score-history (composite
 * trend) and pm:analyst-snapshots (FactSet FY+1 revisions) — all READ-ONLY —
 * and rolls them into intact / eroding / broken per name. Caches the result in
 * pm:thesis-health (regenerable cache; safe to nuke). No live data mutated.
 *
 * ?refresh=1 forces a rebuild (6h freshness otherwise, since the inputs update
 * roughly daily).
 */

const log = createLogger("ThesisHealth");
const CACHE_KEY = "pm:thesis-health";
const STALE_MS = 6 * 60 * 60 * 1000;

type StoredStock = {
  ticker?: string;
  name?: string;
  sector?: string;
  bucket?: string;
  riskAlert?: { level?: string };
};

export async function GET(req: NextRequest) {
  const forceRefresh = new URL(req.url).searchParams.get("refresh") === "1";
  const redis = await getRedis();

  let cached: { builtAt?: string } | null = null;
  try {
    const raw = await redis.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (e) {
    log.warn("cache read failed:", e instanceof Error ? e.message : e);
  }
  const fresh = cached?.builtAt && Date.now() - new Date(cached.builtAt).getTime() < STALE_MS;
  if (fresh && !forceRefresh) return NextResponse.json({ thesisHealth: cached, cached: true });

  try {
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

    const thesisHealth = {
      builtAt: new Date().toISOString(),
      counts: {
        broken: results.filter((r) => r.verdict === "broken").length,
        eroding: results.filter((r) => r.verdict === "eroding").length,
        intact: results.filter((r) => r.verdict === "intact").length,
      },
      holdings: results,
    };

    try {
      await redis.set(CACHE_KEY, JSON.stringify(thesisHealth));
    } catch (e) {
      log.warn("cache write failed:", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ thesisHealth, cached: false });
  } catch (e) {
    log.error("rebuild failed:", e);
    if (cached) return NextResponse.json({ thesisHealth: cached, cached: true, stale: true });
    return NextResponse.json({ thesisHealth: null, error: "unavailable" }, { status: 503 });
  }
}
