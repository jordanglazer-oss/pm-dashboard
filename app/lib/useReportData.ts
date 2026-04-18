"use client";

/**
 * Aggregator hook for the Client Report one-pager. Pulls current
 * positioning, holdings metadata, live prices, sector breakdowns,
 * 5-year historical series, and the PIM Model performance tracker —
 * then computes everything the PDF needs:
 *
 *   • Holdings table — weighted by CURRENT positions (units × live
 *     price in CAD) so the one-pager shows how the model is invested
 *     right now, not the long-term target mix. Falls back to target
 *     weights when no positions are saved in Redis (e.g. a new group).
 *   • Asset allocation pie — Fixed Income, Alternatives, Core ETFs,
 *     US Equity, Canadian Equity, Global Equity (active non-core
 *     equity broken out by the holding's country of exposure).
 *   • Geography mix (country-level weighted exposure) — still exposed
 *     for any downstream consumers that want raw country totals.
 *   • Top sector exposures (equity slice only, look-through on ETFs).
 *   • Look-through X-ray — direct stock positions plus each fund's
 *     Top-10 holdings combined into an effective exposure table, so
 *     AAPL inside XUS.U shows up alongside a direct AAPL position.
 *   • PIM Model performance tracker history + calendar-year returns
 *     (same source the Performance Tracker tab uses — Redis KV
 *     `pm:pim-performance`).
 *   • 5Y annualized return / volatility / upside-downside capture vs
 *     S&P 500 (computed from holdings' adjusted-close history).
 *
 * "Live data" contract: every fetch here is `cache: no-store` and
 * runs against the same endpoints the dashboard already uses, so the
 * one-pager can never show data the rest of the app doesn't already
 * see. If the market is closed, performance metrics use yesterday's
 * close — same as the Appendix ledger.
 */

import { useCallback, useEffect, useState } from "react";
import { useStocks } from "./StockContext";
import { countryFor, CORE_ETF_FAMILIES, coreFamilyFor, isCoreEtf, type Country } from "./geography";
import { normalizeSector } from "./scoring";
import {
  alignSeries,
  annualizedReturn,
  annualizedVolatility,
  captureRatios,
  dailyReturns,
  windowYears,
} from "./report-metrics";
import type {
  PimHolding,
  PimPerformanceData,
  PimPortfolioPositions,
  PimProfileType,
} from "./pim-types";
import type { FundData, FundHolding, FundSectorWeight, Stock } from "./types";

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

/** One slice of the asset allocation pie. Weights are percentages. */
export type ReportAllocationSlice = {
  key:
    | "fixedIncome"
    | "alternatives"
    | "coreEtfs"
    | "usEquity"
    | "canadianEquity"
    | "globalEquity"
    | "preferredShares"
    | "cash";
  label: string;
  weight: number;
  /** CSS hex colour — shared between pie and legend. */
  color: string;
};

/** One row of the look-through X-ray table (top effective exposures). */
export type ReportXRayRow = {
  symbol: string;
  name: string;
  /** Total effective weight (%) = direct + look-through. */
  weight: number;
  /** Weight from direct holdings in the model. */
  direct: number;
  /** Weight contributed via fund look-through (e.g. AAPL inside XUS.U). */
  lookThrough: number;
};

export type ReportPerformanceMetrics = {
  oneYearReturn: number | null;
  threeYearReturn: number | null;
  fiveYearReturn: number | null;
  /** Annualized vol of daily returns, 5y window (fractions — UI multiplies by 100). */
  volatility: number | null;
  upsideCapture: number | null;
  downsideCapture: number | null;
};

/** PIM Model performance tracker payload for the chart + yearly-return table. */
export type ReportTrackerPerformance = {
  /** Full daily-value history from `pm:pim-performance` (value starts at 100). */
  history: { date: string; value: number; dailyReturn: number }[];
  /** Calendar-year returns derived from the history, descending by year. */
  yearlyReturns: { year: number; returnPct: number }[];
  /** Cumulative return since inception (percent, not fraction). */
  sinceInceptionReturnPct: number | null;
  /** Annualized return since inception (percent, not fraction). null if <30 days history. */
  annualizedReturnPct: number | null;
  /** Duration of the history in calendar years (e.g. 2.4). null if unknown. */
  yearsOfHistory: number | null;
};

export type ReportData = {
  groupId: string;
  groupName: string;
  profile: PimProfileType;
  profileLabel: string;
  generatedAt: string;
  /** "live" = weighted by current positions; "target" = weighted by model targets (fallback). */
  weightsSource: "live" | "target";
  holdings: ReportHoldingRow[];
  allocation: ReportAllocationSlice[];
  geography: ReportGeographyRow[];
  sectors: ReportSectorRow[];
  xray: ReportXRayRow[];
  performance: ReportPerformanceMetrics;
  tracker: ReportTrackerPerformance | null;
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

/** Asset allocation pie palette. RBC navy is reserved for Core ETFs
 *  (the flagship slice); equities get a related blue ramp; income and
 *  alternatives use earth tones so they visually recede. */
const SLICE_COLORS: Record<ReportAllocationSlice["key"], string> = {
  fixedIncome: "#5b6b8a",
  alternatives: "#a16207",
  coreEtfs: "#002855",
  usEquity: "#005DAA",
  canadianEquity: "#c8102e",
  globalEquity: "#0d9488",
  preferredShares: "#7c3aed",
  cash: "#94a3b8",
};

const SLICE_LABELS: Record<ReportAllocationSlice["key"], string> = {
  fixedIncome: "Fixed Income",
  alternatives: "Alternatives",
  coreEtfs: "Core ETFs",
  usEquity: "US Equity",
  canadianEquity: "Canadian Equity",
  globalEquity: "Global Equity",
  preferredShares: "Preferred Shares",
  cash: "Cash",
};

function toYahoo(symbol: string): string {
  if (symbol.endsWith(".U")) return symbol.replace(/\.U$/, "-U.TO");
  if (symbol.endsWith("-T")) return symbol.replace(/-T$/, ".TO");
  return symbol;
}

/** Target portfolio weight (as a fraction 0-1) of a holding within its model. */
function targetWeight(
  h: PimHolding,
  profileWeights: { cash: number; fixedIncome: number; equity: number; alternatives: number }
): number {
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

      // ── 1. Current positions + live prices for live weight calc.
      //    We kick these off in parallel so the total network time is
      //    max(positions, prices) rather than a sum.
      const tickerList = group.holdings.map((h) => h.symbol);
      const [positionsRes, priceRes, fxRes, fundCacheRes] = await Promise.all([
        fetch("/api/kv/pim-positions", { cache: "no-store" }).catch(() => null),
        fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: tickerList }),
          cache: "no-store",
        }).catch(() => null),
        fetch("/api/prices", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tickers: ["USDCAD=X"] }),
          cache: "no-store",
        }).catch(() => null),
        // Shared cache of heavy sub-fund top-holdings — populated by
        // Refresh All when it crawls one level deep. Used below to
        // expand ETF-of-ETF positions in the X-ray.
        fetch("/api/kv/fund-data-cache", { cache: "no-store" }).catch(() => null),
      ]);

      // Load sub-fund cache entries. Shape:
      //   { "IVV": { topHoldings: [...], sectorWeightings: [...] } }.
      // The sectorWeightings field is critical: we rely on the fund's
      // published sector mix to avoid the top-holdings bias (top 10
      // holdings typically cover 30-40% of a broad ETF and are
      // concentrated in the largest names, which systematically skews a
      // rollup by sector). The previous typing omitted sectorWeightings,
      // causing them to be silently dropped even when present in Redis.
      let fundCache: Record<string, {
        topHoldings?: FundHolding[];
        sectorWeightings?: FundSectorWeight[];
      }> = {};
      if (fundCacheRes?.ok) {
        try {
          const payload = await fundCacheRes.json();
          fundCache = payload?.entries ?? {};
        } catch {
          /* ignore malformed cache — just use {} */
        }
      }

      let positions: PimPortfolioPositions | null = null;
      if (positionsRes?.ok) {
        try {
          const payload = await positionsRes.json();
          const portfolios: PimPortfolioPositions[] = payload?.portfolios ?? [];
          positions =
            portfolios.find((p) => p.groupId === groupId && p.profile === profile) ??
            null;
        } catch {
          /* ignore malformed positions payload — fall back to target */
        }
      }

      let prices: Record<string, number | null> = {};
      if (priceRes?.ok) {
        try {
          const payload = await priceRes.json();
          prices = payload?.prices ?? {};
        } catch {
          /* ignore — fall back to target below */
        }
      }

      let usdCad = 1;
      if (fxRes?.ok) {
        try {
          const payload = await fxRes.json();
          const rate = payload?.prices?.["USDCAD=X"];
          if (rate && rate > 0) usdCad = rate;
        } catch {
          /* keep 1:1 fallback */
        }
      }

      // ── 2. Compute weights. Prefer live (positions × price × FX) and
      //    fall back to target if positions are missing or add up to
      //    zero value. `weightsSource` is surfaced to the UI so we can
      //    label the report honestly.
      let weightsSource: "live" | "target" = "target";
      const weighted: (PimHolding & { weight: number })[] = [];

      if (positions && positions.positions.length > 0) {
        const posMap = new Map(
          positions.positions.map((p) => [p.symbol, p])
        );
        const valuesCad: { h: PimHolding; valueCad: number }[] = [];
        let totalCad = 0;
        for (const h of group.holdings) {
          const pos = posMap.get(h.symbol);
          if (!pos || pos.units <= 0) continue;
          // `/api/prices` keys by the caller's input ticker, so look up
          // by the raw symbol first, then yahoo-mapped as a safety net.
          const live = prices[h.symbol] ?? prices[toYahoo(h.symbol)] ?? null;
          if (live == null || !isFinite(live) || live <= 0) continue;
          const fx = h.currency === "USD" ? usdCad : 1;
          const valueCad = pos.units * live * fx;
          if (!isFinite(valueCad) || valueCad <= 0) continue;
          valuesCad.push({ h, valueCad });
          totalCad += valueCad;
        }
        if (totalCad > 0 && valuesCad.length > 0) {
          weightsSource = "live";
          for (const { h, valueCad } of valuesCad) {
            weighted.push({ ...h, weight: valueCad / totalCad });
          }
        }
      }

      if (weightsSource === "target") {
        for (const h of group.holdings) {
          weighted.push({ ...h, weight: targetWeight(h, profileWeights) });
        }
      }

      const activeHoldings = weighted.filter((h) => h.weight > 1e-9);

      // ── 3. Holdings table (Core ETFs collapsed to families).
      const holdingRows = consolidateCoreEtfs(activeHoldings);

      // Stamp Alpha bucket for equity rows where the linked Stock is
      // designated "alpha" (or default — designation field is optional
      // on Stock, and everything non-core is alpha by convention).
      const stockBySymbol = new Map<string, Stock>();
      for (const s of stocks) {
        stockBySymbol.set(s.ticker, s);
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

      // ── 4. Asset allocation pie. Rolls each active holding into one
      //    of six named slices. Core ETFs are kept as a single slice,
      //    as requested — X-ray handles their look-through separately.
      const sliceTotals: Record<ReportAllocationSlice["key"], number> = {
        fixedIncome: 0,
        alternatives: 0,
        coreEtfs: 0,
        usEquity: 0,
        canadianEquity: 0,
        globalEquity: 0,
        preferredShares: 0,
        cash: 0,
      };
      for (const h of activeHoldings) {
        const wPct = h.weight * 100;
        if (h.assetClass === "fixedIncome") {
          sliceTotals.fixedIncome += wPct;
        } else if (h.assetClass === "alternative") {
          sliceTotals.alternatives += wPct;
        } else if (isCoreEtf(h.symbol)) {
          sliceTotals.coreEtfs += wPct;
        } else {
          // Non-core equity: split by country of the underlying.
          const c = countryFor(h.symbol);
          if (c === "Canada") sliceTotals.canadianEquity += wPct;
          else if (c === "Global") sliceTotals.globalEquity += wPct;
          else sliceTotals.usEquity += wPct;
        }
      }
      const allocation: ReportAllocationSlice[] = (
        Object.keys(sliceTotals) as ReportAllocationSlice["key"][]
      )
        .map((key) => ({
          key,
          label: SLICE_LABELS[key],
          weight: sliceTotals[key],
          color: SLICE_COLORS[key],
        }))
        .filter((s) => s.weight > 0.05)
        .sort((a, b) => b.weight - a.weight);

      // ── 5. Geography — raw country rollup (kept for downstream use).
      const geoMap = new Map<Country | "Other", number>();
      for (const row of holdingRows) {
        const c = row.country ?? "Other";
        geoMap.set(c, (geoMap.get(c) ?? 0) + row.weight);
      }
      const geography: ReportGeographyRow[] = Array.from(geoMap.entries())
        .map(([country, weight]) => ({ country, weight }))
        .sort((a, b) => b.weight - a.weight);

      // ── 6. Sectors AND X-ray in one fund-data pass.
      //
      // The X-ray is the source of truth for the Current Positioning
      // table, which the user explicitly wants scoped to *individual
      // stock holdings* — core ETFs and mutual-fund positions shouldn't
      // appear as rows themselves; their underlying stocks should roll
      // up into the same pool as directly-held names. So we do a deep
      // recursive expansion: at each level, if the symbol resolves as a
      // stock we accumulate its weight; if it resolves as a fund we
      // recurse into its top holdings with weights scaled by the parent
      // weight; if we can't resolve it at all, we drop it.
      //
      // Sectors are still tallied at the top level (direct stock
      // sector, or the fund's own sectorWeightings scaled by its
      // portfolio weight) — deep recursion doesn't add additional
      // sector contributions, because that would double-count through
      // the fund → stock chain.
      const sectorMap = new Map<string, number>();
      // Filter out non-equity sector names that some providers include
      // (cash, fixed income, government bonds, etc.). The sector chart
      // should reflect equity exposure only and sum to 100%.
      const NON_EQUITY_SECTOR_RE =
        /\b(cash|money\s*market|fixed\s*income|bond|treasury|government|sovereign|short[- ]term|preferred)\b/i;
      const addSector = (name: string, w: number) => {
        if (!name || w <= 0) return;
        if (NON_EQUITY_SECTOR_RE.test(name)) return;
        // Normalize provider-specific sector names to GICS labels so
        // Yahoo's "Financial Services" folds into "Financials",
        // "Consumer Cyclical" into "Consumer Discretionary",
        // "Information Technology" into "Technology", etc. Without this
        // the same economic sector splits across multiple buckets.
        const key = normalizeSector(name);
        sectorMap.set(key, (sectorMap.get(key) ?? 0) + w);
      };

      const xrayAcc = new Map<
        string,
        { name: string; direct: number; lookThrough: number }
      >();
      const addXRay = (
        symbol: string,
        name: string,
        direct: number,
        lookThrough: number
      ) => {
        const key = (symbol || name).toUpperCase();
        if (!key) return;
        const prev = xrayAcc.get(key) ?? { name, direct: 0, lookThrough: 0 };
        prev.direct += direct;
        prev.lookThrough += lookThrough;
        // Prefer the longer, more descriptive name we've seen.
        if (name && name.length > prev.name.length) prev.name = name;
        xrayAcc.set(key, prev);
      };

      // Memoized fund-info lookup. First checks the in-memory
      // fund-data-cache blob (populated by Refresh All), then falls
      // back to a live /api/fund-data fetch. Caches the result per
      // symbol — including negative results — so we only hit the
      // network once per symbol per report render.
      const fundInfoCache = new Map<
        string,
        { topHoldings?: FundHolding[]; sectorWeightings?: FundSectorWeight[] } | null
      >();
      // Normalize symbol format for API calls and cache lookups.
      // PIM model symbols use "-T" for TSX (Globe and Mail convention)
      // while the API and fund-data-cache use ".TO". Normalizing
      // up-front prevents silent misses where XSP-T ≠ XSP.TO in a
      // cache Map, or the API routes XSP-T through the US ETF path.
      const normalizeForApi = (sym: string) =>
        sym.replace(/-T$/, ".TO");

      const getFundInfo = async (sym: string) => {
        const key = sym.toUpperCase();
        // Also check the .TO equivalent key so fund-data-cache entries
        // stored as "XSP.TO" are found when PIM passes "XSP-T".
        const altKey = normalizeForApi(key);
        if (fundInfoCache.has(key)) return fundInfoCache.get(key) ?? null;
        if (key !== altKey && fundInfoCache.has(altKey)) return fundInfoCache.get(altKey) ?? null;
        // 1. User's own stocks list — highest priority because it
        //    includes holdings the user manually fetched via the stock
        //    page's Fetch/URL flow (e.g. FID5982, GRNJ) that may not
        //    be on any of the live sources /api/fund-data hits.
        const ownStock = stockBySymbol.get(sym) ?? stockBySymbol.get(key)
          ?? stockBySymbol.get(altKey);
        if (ownStock?.fundData?.topHoldings?.length) {
          const info = {
            topHoldings: ownStock.fundData.topHoldings,
            sectorWeightings: ownStock.fundData.sectorWeightings,
          };
          fundInfoCache.set(key, info);
          return info;
        }
        // 2. Persisted fund-data-cache (populated by Refresh All's
        //    heavy-child crawl + write-throughs from stock pages).
        //    IMPORTANT: only return early if the cache entry has
        //    sectorWeightings. Without them, the recursive expander
        //    falls back to rolling up sectors from top-10 holdings — a
        //    heavily biased sample for broad ETFs (top 10 typically =
        //    30-40% of the fund, dominated by large-caps, which for
        //    TSX funds means banks). If the cache lacks sectorWeightings
        //    we fall through to the live fetch to get them, even though
        //    topHoldings are present.
        const cached = fundCache[key] ?? fundCache[altKey];
        if (cached?.topHoldings?.length && cached.sectorWeightings?.length) {
          const info = {
            topHoldings: cached.topHoldings,
            sectorWeightings: cached.sectorWeightings,
          };
          fundInfoCache.set(key, info);
          return info;
        }
        // 3. Last-resort live fetch. Use .TO-normalized ticker so the
        //    API routes Canadian ETFs through the correct path.
        const fetchTicker = normalizeForApi(sym);
        try {
          const res = await fetch(
            `/api/fund-data?ticker=${encodeURIComponent(fetchTicker)}`,
            { cache: "no-store" }
          );
          if (!res.ok) { fundInfoCache.set(key, null); return null; }
          const data = await res.json().catch(() => null);
          const fd = data?.fundData as FundData | undefined;
          const info = {
            topHoldings: fd?.topHoldings,
            sectorWeightings: fd?.sectorWeightings,
          };
          fundInfoCache.set(key, info);
          return info;
        } catch {
          fundInfoCache.set(key, null);
          return null;
        }
      };

      // Heuristic used by the recursive expander to decide whether a
      // symbol should be treated as a fund (recurse) or a stock (leaf).
      // Leans toward "stock" when uncertain so we don't drop a direct
      // holding (e.g. "Berkshire Hathaway Class B" shouldn't be treated
      // as a fund). Multiple signals are checked so we don't miss
      // funds whose PIM-holding name is abbreviated ("XSP" vs.
      // "iShares Core S&P 500 Index ETF").
      const looksLikeFund = (sym: string, name: string, st: Stock | undefined): boolean => {
        // Explicit instrument type from the user's stock list.
        if (st?.instrumentType === "stock") return false;
        if (st?.instrumentType === "etf" || st?.instrumentType === "mutual-fund") return true;
        // The stock has fund data cached on it (topHoldings populated
        // from Fetch button / Refresh All).
        if (st?.fundData?.topHoldings?.length) return true;
        // Core ETF list from geography module (isCoreEtf).
        if (isCoreEtf(sym)) return true;
        // FUNDSERV code pattern (FID5982, TDB900, etc.).
        if (/^[A-Z]{2,4}\d{2,5}$/.test(sym)) return true;
        // Fund-data-cache hit — Refresh All's crawl put it there.
        if (fundCache[sym.toUpperCase()]?.topHoldings?.length) return true;
        // Name-based heuristics — last resort.
        const u = (name || "").toUpperCase();
        if (/\bETF\b/.test(u)) return true;
        if (/\bINDEX\b/.test(u)) return true;
        if (/\b(MUTUAL|INDEX|INCOME|BOND|EQUITY)\s+FUND\b/.test(u)) return true;
        if (/\bCLASS\s+[FIOAD]\b/.test(u)) return true;
        if (/\bSERIES\s+[FIOAD]\b/.test(u)) return true;
        return false;
      };

      const MAX_EXPAND_DEPTH = 4;
      /**
       * Recursive expander: resolves funds into their underlying stock
       * leaves for the X-ray table, while simultaneously accumulating
       * sector contributions.
       *
       * `collectSectors` controls whether this branch of the tree should
       * contribute to the sector breakdown. When a fund has its own
       * sectorWeightings, we use those (most accurate — pre-aggregated by
       * the fund provider) and pass `false` to children so we don't
       * double-count. When a fund has no sectorWeightings, children
       * inherit the flag and contribute their own sectors (either from a
       * deeper fund's sectorWeightings or from individual stock sectors).
       */
      const expand = async (
        sym: string,
        name: string,
        weightPct: number,
        depth: number,
        collectSectors: boolean,
      ): Promise<void> => {
        if (weightPct <= 0 || !sym) return;
        const st = stockBySymbol.get(sym);
        const isFund = looksLikeFund(sym, name, st);

        // Leaf — known or assumed stock.
        if (!isFund) {
          const direct = depth === 0 ? weightPct : 0;
          const lookThrough = depth === 0 ? 0 : weightPct;
          addXRay(sym, st?.name || name, direct, lookThrough);
          // Contribute sector from the stock's metadata.
          if (collectSectors && st?.sector) {
            addSector(st.sector, weightPct);
          }
          return;
        }

        // Fund: try to expand. Drop if we can't, per the "individual
        // stocks only" directive.
        if (depth >= MAX_EXPAND_DEPTH) return;
        const info = await getFundInfo(sym);
        const top = info?.topHoldings ?? [];

        // Fund-of-fund detection: when a fund's topHoldings is dominated
        // by a single child that is itself a fund (e.g. XSP holds ~99%
        // IVV; XUH holds ~99% XUU), the parent's sectorWeightings are
        // unreliable across all providers — Yahoo, Morningstar, and
        // iShares CSV all tend to mis-tag the underlying ETF position
        // as a single sector (typically "Financials" because the wrapper
        // structure looks like a financial product). In that case,
        // discard the parent's sectorWeightings and force recursion into
        // the underlying fund where the real sector breakdown lives.
        const dominantChild = top.find((h) => (h.weight || 0) >= 70);
        const dominantChildSym = (dominantChild?.symbol || dominantChild?.name || "").trim();
        const dominantIsFund =
          !!dominantChild &&
          looksLikeFund(
            dominantChildSym,
            dominantChild.name || "",
            stockBySymbol.get(dominantChildSym),
          );
        const isFundOfFund = !!dominantChild && dominantIsFund;

        // Sector handling: use fund-level sectorWeightings when
        // available — they're more accurate than rolling up individual
        // stock sectors and they prevent double-counting through the
        // fund → stock chain. Skip when this is a fund-of-fund wrapper
        // (see above).
        const hasFundSectors =
          collectSectors &&
          !isFundOfFund &&
          (info?.sectorWeightings?.length ?? 0) > 0;
        if (hasFundSectors) {
          for (const sw of info!.sectorWeightings!) {
            addSector(sw.sector, (weightPct * sw.weight) / 100);
          }
        }

        if (!top.length) return;
        // Children only contribute sectors when this fund didn't already
        // provide sectorWeightings. Even then, we only recurse into
        // children for sector purposes if the top holdings are a
        // reasonably complete sample of the fund — otherwise the
        // rollup biases toward the largest names (typically banks in
        // TSX funds), which systematically overstates Financials.
        // Threshold: sum of child weights ≥ 70% of the fund. Below
        // that, we skip sector contribution entirely for this branch
        // rather than present a biased estimate.
        const topHoldingsCoverage = top.reduce((s, h) => s + (h.weight || 0), 0);
        const topHoldingsReliable = topHoldingsCoverage >= 70;
        const childCollectSectors =
          collectSectors && !hasFundSectors && topHoldingsReliable;
        await Promise.all(
          top.map((h) => {
            const childSym = (h.symbol || h.name || "").trim();
            if (!childSym) return Promise.resolve();
            const childWeight = (weightPct * h.weight) / 100;
            return expand(childSym, h.name, childWeight, depth + 1, childCollectSectors);
          })
        );
      };

      await Promise.all(
        activeHoldings.map(async (h) => {
          if (h.assetClass !== "equity") return;
          const wPct = h.weight * 100;
          // Deep recursive expansion for positions AND sectors.
          await expand(h.symbol, h.name, wPct, 0, true);
        })
      );

      // Normalize sector weights to sum to 100%. Raw weights are
      // proportional to each holding's portfolio weight, so they sum
      // to less than 100% when the portfolio includes non-equity
      // positions (fixed income, alternatives, cash). Dividing by the
      // raw total rescales to a pure equity-sector breakdown.
      const rawSectorTotal = Array.from(sectorMap.values()).reduce(
        (s, v) => s + v,
        0
      );
      const sectors: ReportSectorRow[] =
        rawSectorTotal > 0
          ? Array.from(sectorMap.entries())
              .map(([sector, weight]) => ({
                sector,
                weight: (weight / rawSectorTotal) * 100,
              }))
              .sort((a, b) => b.weight - a.weight)
          : [];

      const xray: ReportXRayRow[] = Array.from(xrayAcc.entries())
        .map(([symbol, v]) => ({
          symbol,
          name: v.name,
          direct: v.direct,
          lookThrough: v.lookThrough,
          weight: v.direct + v.lookThrough,
        }))
        .filter((r) => r.weight > 0.05)
        .sort((a, b) => b.weight - a.weight);

      // ── 7. PIM Model performance tracker history + yearly returns.
      let tracker: ReportTrackerPerformance | null = null;
      try {
        const res = await fetch("/api/kv/pim-performance", { cache: "no-store" });
        if (res.ok) {
          const payload = (await res.json()) as PimPerformanceData | null;
          const model = payload?.models?.find(
            (m) => m.groupId === groupId && m.profile === profile
          );
          if (model && model.history.length > 1) {
            tracker = buildTrackerPerformance(model.history);
          }
        }
      } catch {
        /* leave tracker null */
      }

      // ── 8. 5Y analytic metrics from adjusted-close history (kept
      //     from v1 for vol + upside/downside capture; the display on
      //     the report leans on tracker history for yearly returns).
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

      // ── 9. Totals — straight sum of weights by currency bucket.
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
        weightsSource,
        holdings: holdingRows,
        allocation,
        geography,
        sectors,
        xray,
        performance,
        tracker,
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
    compute();
  }, [compute]);

  return { data, loading, error, refetch: compute };
}

// ───────── Tracker (calendar-year returns) ─────────

/**
 * Build the tracker-performance block from the Redis pim-performance
 * history. Yearly return = (last entry of year N) / (last entry of
 * year N-1, or seed value if year N is the first year). Current year
 * is computed YTD from Dec 31 of the prior year to the latest entry.
 *
 * We feed the raw history straight into the chart component and let
 * it downsample visually — the PDF renders fine with a few thousand
 * points as long as the SVG path stays < ~100KB.
 */
function buildTrackerPerformance(
  history: { date: string; value: number; dailyReturn: number }[]
): ReportTrackerPerformance {
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));

  // Group the last entry of each year (and also the first to anchor).
  const lastByYear = new Map<number, { date: string; value: number }>();
  for (const h of sorted) {
    const y = Number(h.date.slice(0, 4));
    if (!isFinite(y)) continue;
    lastByYear.set(y, { date: h.date, value: h.value });
  }

  const years = Array.from(lastByYear.keys()).sort((a, b) => a - b);
  const firstEntry = sorted[0];
  const yearlyReturns: { year: number; returnPct: number }[] = [];
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    const endOfY = lastByYear.get(y);
    if (!endOfY) continue;
    // Prior year-end is the anchor. If no prior year exists, use the
    // first history entry as the anchor (inception year partial return).
    const startVal =
      i === 0 ? firstEntry.value : lastByYear.get(years[i - 1])?.value ?? firstEntry.value;
    if (!startVal) continue;
    const ret = (endOfY.value / startVal - 1) * 100;
    if (isFinite(ret)) yearlyReturns.push({ year: y, returnPct: ret });
  }
  // Most-recent year first in the table.
  yearlyReturns.sort((a, b) => b.year - a.year);

  const first = sorted[0]?.value ?? null;
  const last = sorted[sorted.length - 1]?.value ?? null;
  const sinceInceptionReturnPct =
    first != null && last != null && first > 0 ? (last / first - 1) * 100 : null;

  // Annualized return: (endValue / startValue)^(1/years) - 1. Only meaningful
  // for ≥30 days of history; below that, short-term noise dominates and the
  // extrapolation is misleading.
  let yearsOfHistory: number | null = null;
  let annualizedReturnPct: number | null = null;
  if (sorted.length >= 2) {
    const startMs = new Date(sorted[0].date).getTime();
    const endMs = new Date(sorted[sorted.length - 1].date).getTime();
    if (isFinite(startMs) && isFinite(endMs) && endMs > startMs) {
      const years = (endMs - startMs) / (365.25 * 24 * 60 * 60 * 1000);
      yearsOfHistory = years;
      if (years >= 30 / 365.25 && first != null && last != null && first > 0) {
        const total = last / first;
        if (total > 0) annualizedReturnPct = (Math.pow(total, 1 / years) - 1) * 100;
      }
    }
  }

  return {
    history: sorted,
    yearlyReturns,
    sinceInceptionReturnPct,
    annualizedReturnPct,
    yearsOfHistory,
  };
}

// ───────── Performance metrics (local helper) ─────────

/**
 * Given target-weighted holdings and a map of adjusted-close series,
 * compute 1Y / 3Y / 5Y annualized returns, annualized volatility, and
 * upside/downside capture vs S&P 500.
 *
 * Uses the weights the caller passes in throughout (rebalanced daily,
 * implicitly). Per-holding FX noise is ignored because capture ratios
 * and return-based vol are FX-invariant when the benchmark is in a
 * single currency: both numerator and denominator drift together.
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

  const entries: { weight: number; series: [number, number][] }[] = [];
  let covered = 0;
  for (const h of holdings) {
    const raw = series[h.symbol] ?? series[toYahoo(h.symbol)] ?? [];
    if (!raw.length) continue;
    entries.push({ weight: h.weight, series: raw });
    covered += h.weight;
  }

  if (!entries.length || covered < 0.5) {
    return {
      oneYearReturn: null,
      threeYearReturn: null,
      fiveYearReturn: null,
      volatility: null,
      upsideCapture: null,
      downsideCapture: null,
    };
  }

  const scale = 1 / covered;
  for (const e of entries) e.weight *= scale;

  const benchDates = bench.map(([t]) => t);
  const benchPrices = bench.map(([, p]) => p);
  const sampled: number[][] = entries.map((e) => sampleOnDates(e.series, benchDates));
  const normalized = sampled.map((s) => normalizeToStart(s));
  const portfolio: number[] = new Array(benchDates.length).fill(0);
  for (let i = 0; i < benchDates.length; i++) {
    let v = 0;
    for (let j = 0; j < entries.length; j++) {
      v += entries[j].weight * normalized[j][i];
    }
    portfolio[i] = v;
  }

  const portfolioSeries: [number, number][] = benchDates.map((t, i) => [t, portfolio[i]]);
  const benchSeries: [number, number][] = benchDates.map((t, i) => [t, benchPrices[i]]);

  const pricesIn = (s: [number, number][], years: number) =>
    windowYears(s, years).map(([, p]) => p);

  const oneYearReturn = annualizedReturn(pricesIn(portfolioSeries, 1), 1);
  const threeYearReturn = annualizedReturn(pricesIn(portfolioSeries, 3), 3);
  const fiveYearReturn = annualizedReturn(pricesIn(portfolioSeries, 5), 5);

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
