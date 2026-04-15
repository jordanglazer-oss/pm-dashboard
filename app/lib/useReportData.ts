"use client";

/**
 * Aggregator hook for the Client Report one-pager. Pulls current
 * positioning, holdings metadata, live prices, sector breakdowns, and
 * 5-year historical series — then computes everything the PDF needs:
 *
 *   • Holdings table (Core ETFs consolidated into family rows with
 *     CAD/USD sub-splits; Alpha & individual names listed separately).
 *   • Geography mix (country-level weighted exposure).
 *   • Top sector exposures (equity slice only, look-through on ETFs).
 *   • Performance metrics (1Y / 3Y / 5Y annualized return + volatility
 *     + upside/downside capture vs S&P 500).
 *
 * "Live data" contract: every fetch here is `cache: no-store` and runs
 * against the same endpoints the dashboard already uses, so the one-
 * pager can never show data the rest of the app doesn't already see.
 * If the market is closed, performance metrics use yesterday's close —
 * same as the Appendix ledger.
 */

import { useCallback, useEffect, useState } from "react";
import { useStocks } from "./StockContext";
import { countryFor, CORE_ETF_FAMILIES, coreFamilyFor, type Country } from "./geography";
import {
  alignSeries,
  annualizedReturn,
  annualizedVolatility,
  captureRatios,
  dailyReturns,
  windowYears,
} from "./report-metrics";
import type { PimHolding, PimProfileType } from "./pim-types";
import type { FundData, Stock } from "./types";

// ───────── Output shape ─────────

export type ReportHoldingRow = {
  /** Display name. For Core families this is the family label, for named holdings it's `Stock.name` / `PimHolding.name`. */
  name: string;
  /** Internal id used for React keys — either a symbol or a `core:<family>` string. */
  id: string;
  /** Portfolio weight (%) — sum across rows should equal ~100. */
  weight: number;
  /** For Core family rows: portfolio weight contributed by CAD-listed variant. */
  cadWeight?: number;
  /** For Core family rows: portfolio weight contributed by USD-listed variant. */
  usdWeight?: number;
  /** Bucket label for the table section ("Fixed Income", "Equity", "Core", "Alpha", "Alternatives"). */
  bucket: "Fixed Income" | "Equity" | "Core" | "Alpha" | "Alternatives";
  /** Country for geography attribution. Core families use the underlying market. */
  country: Country;
};

export type ReportGeographyRow = { country: Country | "Other"; weight: number };

export type ReportSectorRow = { sector: string; weight: number };

export type ReportPerformanceMetrics = {
  oneYearReturn: number | null;
  threeYearReturn: number | null;
  fiveYearReturn: number | null;
  /** Annualized vol of daily returns, 5y window (fractions — UI multiplies by 100). */
  volatility: number | null;
  upsideCapture: number | null;
  downsideCapture: number | null;
};

export type ReportData = {
  groupId: string;
  groupName: string;
  profile: PimProfileType;
  profileLabel: string;
  generatedAt: string;
  holdings: ReportHoldingRow[];
  geography: ReportGeographyRow[];
  sectors: ReportSectorRow[];
  performance: ReportPerformanceMetrics;
  /**
   * Summary totals of the holdings table, for quick sanity display on
   * the preview and inside the PDF footer.
   */
  totals: { cad: number; usd: number; cash: number };
};

export type UseReportDataResult = {
  data: ReportData | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
};

// ───────── Helpers ─────────

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "PIM Balanced",
  growth: "PIM Growth",
  allEquity: "PIM All-Equity",
  alpha: "Alpha",
};

function toYahoo(symbol: string): string {
  if (symbol.endsWith(".U")) return symbol.replace(/\.U$/, "-U.TO");
  if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
  return symbol;
}

/** Target portfolio weight (as a fraction 0-1) of a holding within its model. */
function targetWeight(h: PimHolding, profileWeights: {
  cash: number;
  fixedIncome: number;
  equity: number;
  alternatives: number;
}): number {
  if (h.assetClass === "fixedIncome") return h.weightInClass * profileWeights.fixedIncome;
  if (h.assetClass === "equity") return h.weightInClass * profileWeights.equity;
  if (h.assetClass === "alternative") return h.weightInClass * profileWeights.alternatives;
  return 0;
}

/** Group Core ETFs by family; pass-through everything else. */
function consolidateCoreEtfs(
  holdings: (PimHolding & { weight: number })[]
): ReportHoldingRow[] {
  const rows: ReportHoldingRow[] = [];
  const families = new Map<
    string,
    { name: string; cad: number; usd: number; weight: number }
  >();

  for (const h of holdings) {
    const fam = coreFamilyFor(h.symbol);
    if (fam) {
      const label = CORE_ETF_FAMILIES[fam] ?? fam;
      const prev = families.get(fam) ?? { name: label, cad: 0, usd: 0, weight: 0 };
      prev.weight += h.weight;
      if (h.currency === "CAD") prev.cad += h.weight;
      else prev.usd += h.weight;
      families.set(fam, prev);
    } else {
      rows.push({
        name: h.name,
        id: h.symbol,
        weight: h.weight * 100,
        bucket: bucketFor(h),
        country: countryFor(h.symbol),
      });
    }
  }

  for (const [fam, v] of families) {
    rows.push({
      name: v.name,
      id: `core:${fam}`,
      weight: v.weight * 100,
      cadWeight: v.cad * 100,
      usdWeight: v.usd * 100,
      bucket: "Core",
      // Core ETFs all track US markets in the current lineup.
      country: "United States",
    });
  }

  return rows;
}

function bucketFor(h: PimHolding): ReportHoldingRow["bucket"] {
  if (h.assetClass === "fixedIncome") return "Fixed Income";
  if (h.assetClass === "alternative") return "Alternatives";
  // Equity — Core is handled separately above, so here we only split
  // named equities into Alpha vs Equity. We don't know designation from
  // PimHolding alone; caller stamps it post-hoc if needed. Default to
  // "Equity" so the row still renders correctly.
  return "Equity";
}

// ───────── The hook ─────────

export function useReportData(
  groupId: string,
  profile: PimProfileType
): UseReportDataResult {
  const { pimModels, stocks } = useStocks();
  const [data, setData] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compute = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      const group = pimModels.groups.find((g) => g.id === groupId);
      if (!group) throw new Error(`Unknown PIM group "${groupId}"`);
      const profileWeights = group.profiles[profile];
      if (!profileWeights)
        throw new Error(`Profile "${profile}" not defined for ${group.name}`);

      // 1. Compute target weights for every holding. We use target
      //    (model) weights rather than drift-adjusted live weights so
      //    the one-pager represents our intended positioning.
      const weighted: (PimHolding & { weight: number })[] = group.holdings.map((h) => ({
        ...h,
        weight: targetWeight(h, profileWeights),
      }));

      // Filter out zero-weighted holdings (e.g. alternatives when
      // alternatives allocation is 0 for some profile).
      const activeHoldings = weighted.filter((h) => h.weight > 1e-9);

      // 2. Holdings table (Core ETFs collapsed to families).
      const holdingRows = consolidateCoreEtfs(activeHoldings);

      // Stamp Alpha bucket for equity rows where the linked Stock is
      // designated "alpha" (or default — designation field is optional
      // on Stock, and everything non-core is alpha by convention).
      const stockBySymbol = new Map<string, Stock>();
      for (const s of stocks) {
        stockBySymbol.set(s.ticker, s);
        // Also index the CAD-suffix variant we use internally ("-T").
        if (s.ticker.endsWith(".TO")) {
          stockBySymbol.set(s.ticker.replace(/\.TO$/, "-T"), s);
        }
      }
      for (const row of holdingRows) {
        if (row.bucket !== "Equity") continue;
        const s = stockBySymbol.get(row.id);
        if (s?.designation === "core") row.bucket = "Core";
        else row.bucket = "Alpha";
      }

      // 3. Geography — weighted by holding weight. Individual equities
      //    and Core family rows all contribute; unknown symbols land in
      //    "Other".
      const geoMap = new Map<Country | "Other", number>();
      for (const row of holdingRows) {
        const c = row.country ?? "Other";
        geoMap.set(c, (geoMap.get(c) ?? 0) + row.weight);
      }
      const geography: ReportGeographyRow[] = Array.from(geoMap.entries())
        .map(([country, weight]) => ({ country, weight }))
        .sort((a, b) => b.weight - a.weight);

      // 4. Sectors — look up cached fund-data for each ETF / fund and
      //    combine with direct `sector` on Stock records for names.
      //    This fetch is per-symbol and sequential-via-Promise.all to
      //    keep things simple; it'll be quick because results are
      //    cached server-side.
      const sectorMap = new Map<string, number>();
      const addSector = (name: string, w: number) => {
        if (!name || w <= 0) return;
        sectorMap.set(name, (sectorMap.get(name) ?? 0) + w);
      };

      await Promise.all(
        activeHoldings
          .filter((h) => h.assetClass === "equity")
          .map(async (h) => {
            const st = stockBySymbol.get(h.symbol);
            // If this is a direct equity with a known sector, attribute
            // the full weight to that sector and skip the fund look-up.
            if (st?.sector && st.instrumentType === "stock") {
              addSector(st.sector, h.weight * 100);
              return;
            }
            // Otherwise look up fund sector breakdown (ETFs, MFs).
            try {
              const res = await fetch(
                `/api/fund-data?ticker=${encodeURIComponent(h.symbol)}`,
                { cache: "no-store" }
              );
              if (!res.ok) return;
              const fund: FundData | null = await res.json().catch(() => null);
              const breakdown = fund?.sectorWeightings ?? [];
              if (!breakdown.length) return;
              // sectorWeightings are already % of fund → multiply by
              // portfolio weight to get contribution.
              for (const sw of breakdown) {
                addSector(sw.sector, h.weight * sw.weight);
              }
            } catch {
              /* swallow — sector attribution best-effort */
            }
          })
      );

      const sectors: ReportSectorRow[] = Array.from(sectorMap.entries())
        .map(([sector, weight]) => ({ sector, weight }))
        .sort((a, b) => b.weight - a.weight);

      // 5. Performance metrics — fetch 5y adjusted close for every
      //    holding + S&P 500 (^GSPC). Build a weighted return series
      //    for the portfolio and compare against the benchmark.
      const tickers = activeHoldings.map((h) => h.symbol);
      let performance: ReportPerformanceMetrics = {
        oneYearReturn: null,
        threeYearReturn: null,
        fiveYearReturn: null,
        volatility: null,
        upsideCapture: null,
        downsideCapture: null,
      };
      try {
        const histRes = await fetch("/api/report-history", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: [...tickers, "^GSPC"], range: "5y" }),
          cache: "no-store",
        });
        if (histRes.ok) {
          const { series } = (await histRes.json()) as {
            series: Record<string, [number, number][]>;
          };
          performance = computePerformance(activeHoldings, series);
        }
      } catch {
        /* leave performance as all-null */
      }

      // 6. Totals — straight sum of weights by currency bucket.
      const totals = { cad: 0, usd: 0, cash: 0 };
      for (const h of activeHoldings) {
        if (h.currency === "CAD") totals.cad += h.weight * 100;
        else totals.usd += h.weight * 100;
      }
      totals.cash = Math.max(0, 100 - (totals.cad + totals.usd));

      // Sort holdings inside each bucket by descending weight.
      const bucketOrder: Record<ReportHoldingRow["bucket"], number> = {
        "Fixed Income": 0,
        Core: 1,
        Equity: 2,
        Alpha: 3,
        Alternatives: 4,
      };
      holdingRows.sort((a, b) => {
        const ba = bucketOrder[a.bucket];
        const bb = bucketOrder[b.bucket];
        if (ba !== bb) return ba - bb;
        return b.weight - a.weight;
      });

      setData({
        groupId,
        groupName: group.name,
        profile,
        profileLabel: PROFILE_LABELS[profile] ?? String(profile),
        generatedAt: new Date().toISOString(),
        holdings: holdingRows,
        geography,
        sectors,
        performance,
        totals,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to build report");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [groupId, profile, pimModels, stocks]);

  useEffect(() => {
    // Async setState inside — can't cascade-render synchronously.
    compute();
  }, [compute]);

  return { data, loading, error, refetch: compute };
}

// ───────── Performance metrics (local helper) ─────────

/**
 * Given target-weighted holdings and a map of adjusted-close series,
 * compute the model's 1Y / 3Y / 5Y annualized returns, annualized
 * volatility, and upside/downside capture vs S&P 500.
 *
 * Uses target weights throughout (rebalanced daily, implicitly) rather
 * than accreting weights — this represents the "model" return, which
 * is what the one-pager advertises. Per-holding FX noise is ignored
 * because capture ratios and return-based vol are FX-invariant when
 * the benchmark is in a single currency: both numerator and
 * denominator drift together.
 */
function computePerformance(
  holdings: (PimHolding & { weight: number })[],
  series: Record<string, [number, number][]>
): ReportPerformanceMetrics {
  const bench = series["^GSPC"] ?? [];
  if (!bench.length) {
    return {
      oneYearReturn: null,
      threeYearReturn: null,
      fiveYearReturn: null,
      volatility: null,
      upsideCapture: null,
      downsideCapture: null,
    };
  }

  // Collect series for every holding that has data. Fall back to the
  // Yahoo-suffixed variant if the raw symbol wasn't keyed directly
  // (report-history API keys by the caller's input ticker, so this
  // should be a no-op — belt and suspenders).
  const entries: {
    weight: number;
    series: [number, number][];
  }[] = [];
  let covered = 0;
  for (const h of holdings) {
    const raw = series[h.symbol] ?? series[toYahoo(h.symbol)] ?? [];
    if (!raw.length) continue;
    entries.push({ weight: h.weight, series: raw });
    covered += h.weight;
  }

  if (!entries.length || covered < 0.5) {
    // Less than half the portfolio has history — not enough to make
    // an honest claim about performance. Bail.
    return {
      oneYearReturn: null,
      threeYearReturn: null,
      fiveYearReturn: null,
      volatility: null,
      upsideCapture: null,
      downsideCapture: null,
    };
  }

  // Normalize weights across covered holdings so they sum to 1 — this
  // redistributes FUNDSERV-missing weight proportionally rather than
  // pretending it's cash.
  const scale = 1 / covered;
  for (const e of entries) e.weight *= scale;

  // Build a single sorted-by-date "union" calendar from the benchmark
  // (densest trading calendar available), then sample each holding on
  // those dates. Holdings with gaps on a given day get their previous
  // close carried forward (typical in ETFs with thin trading days).
  const benchDates = bench.map(([t]) => t);
  const benchPrices = bench.map(([, p]) => p);

  // For each entry, build a ffill-sampled price series on benchmark dates.
  const sampled: number[][] = entries.map((e) => sampleOnDates(e.series, benchDates));

  // Portfolio value series = weighted sum of each entry's normalized
  // price series (start each at 1, so weights blend correctly).
  const normalized = sampled.map((series) => normalizeToStart(series));
  const portfolio: number[] = new Array(benchDates.length).fill(0);
  for (let i = 0; i < benchDates.length; i++) {
    let v = 0;
    for (let j = 0; j < entries.length; j++) {
      v += entries[j].weight * normalized[j][i];
    }
    portfolio[i] = v;
  }

  // Pair as [t, price] for windowYears helpers.
  const portfolioSeries: [number, number][] = benchDates.map((t, i) => [t, portfolio[i]]);
  const benchSeries: [number, number][] = benchDates.map((t, i) => [t, benchPrices[i]]);

  // Annualized returns over 1y / 3y / 5y windows.
  const pricesIn = (s: [number, number][], years: number) =>
    windowYears(s, years).map(([, p]) => p);

  const oneYearReturn = annualizedReturn(pricesIn(portfolioSeries, 1), 1);
  const threeYearReturn = annualizedReturn(pricesIn(portfolioSeries, 3), 3);
  const fiveYearReturn = annualizedReturn(pricesIn(portfolioSeries, 5), 5);

  // Volatility + capture use full 5y window.
  const portReturns = dailyReturns(pricesIn(portfolioSeries, 5));
  const volatility = annualizedVolatility(portReturns);

  const aligned = alignSeries(windowYears(portfolioSeries, 5), windowYears(benchSeries, 5));
  const portR = dailyReturns(aligned.a);
  const benchR = dailyReturns(aligned.b);
  const { upside, downside } = captureRatios(portR, benchR);

  return {
    oneYearReturn,
    threeYearReturn,
    fiveYearReturn,
    volatility,
    upsideCapture: upside,
    downsideCapture: downside,
  };
}

/**
 * Resample a sparse `[t, price]` series onto a dense date vector by
 * carrying forward the last observed price (no interpolation). Prices
 * before the first observation become NaN so downstream math can skip
 * them.
 */
function sampleOnDates(series: [number, number][], dates: number[]): number[] {
  const out: number[] = new Array(dates.length).fill(NaN);
  let j = 0;
  let last = NaN;
  for (let i = 0; i < dates.length; i++) {
    const target = dates[i];
    while (j < series.length && series[j][0] <= target) {
      last = series[j][1];
      j++;
    }
    out[i] = last;
  }
  return out;
}

/** Rebase a price series so the first finite value becomes 1. */
function normalizeToStart(series: number[]): number[] {
  let base = NaN;
  for (const v of series) {
    if (isFinite(v) && v > 0) {
      base = v;
      break;
    }
  }
  if (!isFinite(base)) return series.map(() => NaN);
  return series.map((v) => (isFinite(v) ? v / base : NaN));
}
