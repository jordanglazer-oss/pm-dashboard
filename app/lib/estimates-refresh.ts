import { getRedis } from "@/app/lib/redis";
import { getFactsetEstimatesByTicker } from "@/app/lib/factset";
import {
  getSnapshotForTicker,
  setSnapshotForTicker,
  type AnalystSnapshots,
} from "@/app/lib/analyst-snapshots";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Estimates-refresh");

/** Small marker written after every run so the nav chip can show freshness.
 *  Pure derived status — safe to nuke (the next run rewrites it). */
export const ESTIMATES_STATUS_KEY = "pm:estimates-refresh-status";

export type EstimatesRefreshStatus = {
  lastRunAt: string;      // ISO
  tickerCount: number;    // Portfolio + Watchlist tickers considered
  resolvedCount: number;  // how many FactSet returned estimate data for
  updatedCount: number;   // how many snapshot entries actually changed
  error?: string;
};

type StockRow = { ticker?: string; bucket?: string };

/**
 * Refresh the lightweight FactSet analyst-estimate fields (mean target price,
 * analyst count, EPS FY+1 up/down revisions) for every Portfolio + Watchlist
 * holding — WITHOUT a full rescore. Costs ~1-2 batched FactSet calls total.
 *
 * Redis safety: touches exactly two keys.
 *   • pm:analyst-snapshots — READ-MERGE-WRITE. For each ticker we only set the
 *     `.factset` sub-object (averageTarget/analystCount/revUp/revDown/asOf/
 *     lastUpdated), spreading the existing ticker snapshot so `.rbc`/`.jpm`
 *     and every other ticker are preserved verbatim. Individual fields fall
 *     back to the prior value when FactSet returns null, so a partial response
 *     never wipes good data.
 *   • pm:estimates-refresh-status — a tiny derived freshness marker.
 * Never deletes; fully reversible (next run re-fills).
 */
export async function refreshFactsetEstimates(): Promise<EstimatesRefreshStatus> {
  const redis = await getRedis();
  const nowIso = new Date().toISOString();
  const today = nowIso.slice(0, 10);

  // Tickers = Portfolio + Watchlist from pm:stocks.
  let tickers: string[] = [];
  try {
    const rawStocks = await redis.get("pm:stocks");
    const stocks = rawStocks ? (JSON.parse(rawStocks) as StockRow[]) : [];
    tickers = Array.from(
      new Set(
        stocks
          .filter((s) => s.bucket === "Portfolio" || s.bucket === "Watchlist")
          .map((s) => (s.ticker || "").trim().toUpperCase())
          .filter(Boolean)
      )
    );
  } catch (e) {
    const status: EstimatesRefreshStatus = {
      lastRunAt: nowIso, tickerCount: 0, resolvedCount: 0, updatedCount: 0,
      error: `read pm:stocks failed: ${e instanceof Error ? e.message : String(e)}`,
    };
    await redis.set(ESTIMATES_STATUS_KEY, JSON.stringify(status)).catch(() => {});
    return status;
  }

  if (tickers.length === 0) {
    const status: EstimatesRefreshStatus = { lastRunAt: nowIso, tickerCount: 0, resolvedCount: 0, updatedCount: 0 };
    await redis.set(ESTIMATES_STATUS_KEY, JSON.stringify(status)).catch(() => {});
    return status;
  }

  // One (chunked) batched FactSet call for the whole book.
  const estimates = await getFactsetEstimatesByTicker(tickers);
  const resolvedTickers = Object.keys(estimates);

  // Read-merge-write pm:analyst-snapshots ONCE.
  let updatedCount = 0;
  try {
    const raw = await redis.get("pm:analyst-snapshots");
    let blob = raw ? (JSON.parse(raw) as AnalystSnapshots) : {};
    for (const ticker of resolvedTickers) {
      const est = estimates[ticker];
      const existing = getSnapshotForTicker(blob, ticker) || {};
      const prevFs = existing.factset || {};
      const nextFs = {
        averageTarget: est.tgtPriceMean ?? prevFs.averageTarget,
        analystCount: est.numEstFy1 ?? prevFs.analystCount,
        revUp: est.revUp ?? prevFs.revUp,
        revDown: est.revDown ?? prevFs.revDown,
        epsBeats: est.epsBeats ?? prevFs.epsBeats,
        asOf: today,
        lastUpdated: today,
      };
      // Skip a no-op write if nothing of substance changed (ignore the date-only
      // fields) so updatedCount reflects real movement.
      const changed =
        nextFs.averageTarget !== prevFs.averageTarget ||
        nextFs.analystCount !== prevFs.analystCount ||
        nextFs.revUp !== prevFs.revUp ||
        nextFs.revDown !== prevFs.revDown ||
        JSON.stringify(nextFs.epsBeats ?? null) !== JSON.stringify(prevFs.epsBeats ?? null) ||
        prevFs.asOf !== today;
      if (!changed) continue;
      blob = setSnapshotForTicker(blob, ticker, { ...existing, factset: nextFs });
      updatedCount++;
    }
    if (updatedCount > 0) {
      await redis.set("pm:analyst-snapshots", JSON.stringify(blob));
    }
  } catch (e) {
    const status: EstimatesRefreshStatus = {
      lastRunAt: nowIso, tickerCount: tickers.length, resolvedCount: resolvedTickers.length, updatedCount,
      error: `analyst-snapshots merge failed: ${e instanceof Error ? e.message : String(e)}`,
    };
    await redis.set(ESTIMATES_STATUS_KEY, JSON.stringify(status)).catch(() => {});
    log.error("merge failed:", e instanceof Error ? e.message : e);
    return status;
  }

  const status: EstimatesRefreshStatus = {
    lastRunAt: nowIso,
    tickerCount: tickers.length,
    resolvedCount: resolvedTickers.length,
    updatedCount,
  };
  await redis.set(ESTIMATES_STATUS_KEY, JSON.stringify(status)).catch(() => {});
  log.info(`done — ${resolvedTickers.length}/${tickers.length} resolved, ${updatedCount} updated`);
  return status;
}
