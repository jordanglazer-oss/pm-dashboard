"use client";

import React, { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { Stock, MarketData, ScoredStock, MorningBrief, ScoreKey, ScoreExplanations, HealthData, TechnicalIndicators, RiskAlert, FundData } from "./types";
import type { PimHolding, PimModelData, PimModelGroup, PimPortfolioState, PimModelGroupState } from "./pim-types";
import { computeScores, isOffensiveSector, isScoreable } from "./scoring";
import { defaultMarketData } from "./defaults";
// pim-seed is now a LAST-RESORT FALLBACK only. The authoritative baseline
// lives in Redis under `pm:pim-model-baseline` and is fetched on mount into
// the `pimBaseline` state below. The seed is used (a) as the synchronous
// initial value for the first render before the Redis fetch resolves, and
// (b) if the Redis fetch fails or the key is missing. This makes the app
// resilient to a missing Redis key without making the seed the source of
// truth for the rebalance math.
import { pimModelSeed as pimModelSeedFallback } from "./pim-seed";
import type { AnalystSnapshots, TickerSnapshot, AnalystReports, TickerReports, AnalystEntry, ExtractedReport } from "./analyst-snapshots";
import { setSnapshotForTicker, getSnapshotForTicker, setReportsForTicker, getReportsForTicker, reportIdFor, computeAnalystConsensus, buildConsensusExplanation } from "./analyst-snapshots";
import { mapBoostedAiToAiRating, mapSmaxToRelativeStrength, type BoostedAiConsensus } from "./external-scoring";
import { buildResearchMentionsExplanation } from "./research-mentions-display";

// Legacy lock list — kept ONLY as a fallback for holdings that have no
// corresponding entry in pm:stocks (and therefore no `designation` field).
// The primary lock mechanism is now driven by per-stock `designation` in
// pm:stocks (Core vs Alpha), set by the user via the Role toggle in the
// Stocks tab. See `isAlphaLockedHolding` below.
//
// Why this fallback exists: historically the lock list was the only
// mechanism. If pm:stocks somehow loses an entry (or one was never created
// for a fund that exists in pm:pim-models), we want to fail safe by still
// locking the three specialty funds that were originally hardcoded — they
// would otherwise be silently re-scaled into the Core ETF residual pool.
const LEGACY_LOCKED_EQUITY_SYMBOLS = new Set(["FID5982", "FID5982-T", "GRNJ"]);

// One-shot migration for the Research-category restructure (researchCoverage
// shrank from max 4 → 1, externalSources from max 4 → 1, and two new
// deterministic keys analystConsensus + researchMentions were added at max 3
// each). Clamps over-cap values and defaults missing keys to 0 so old blobs
// keep rendering until the PM rescores. Returns the migrated stocks plus a
// boolean indicating whether any stock changed so the caller can persist.
function migrateStockScores(stocks: Stock[]): { migrated: Stock[]; changed: boolean } {
  let changed = false;
  const migrated = stocks.map((s) => {
    const scores = s.scores || ({} as Stock["scores"]);
    const rc = scores.researchCoverage ?? 0;
    const ac = scores.analystConsensus;
    const rm = scores.researchMentions;
    const needsRcClamp = rc > 1;
    const needsAcDefault = ac === undefined || ac === null;
    const needsRmDefault = rm === undefined || rm === null;
    if (!needsRcClamp && !needsAcDefault && !needsRmDefault) return s;
    changed = true;
    return {
      ...s,
      scores: {
        ...scores,
        researchCoverage: Math.min(rc, 1),
        analystConsensus: needsAcDefault ? 0 : ac,
        researchMentions: needsRmDefault ? 0 : rm,
      },
    };
  });
  return { migrated, changed };
}

export type ChartAnalysisEntry = {
  analysis: string;
  range: string;
  analyzedAt: string;
  // Structured fields added 2026-05-26. All optional so saved analyses
  // generated before this commit (which only have `analysis`) continue to
  // render via the legacy prose path.
  outlook?: "Bullish" | "Neutral" | "Bearish";
  confidence?: number; // 0–1
  bullCase?: string;
  bearCase?: string;
  support?: number[];
  resistance?: number[];
  stopBelow?: number | null;
  nextAction?: string;
};

export type ScannerData = {
  results: unknown[];
  meta: { total: number; found: number; scannedAt: string; universe: string; minScore: number } | null;
};

type StockContextType = {
  stocks: Stock[];
  scoredStocks: ScoredStock[];
  marketData: MarketData;
  brief: MorningBrief | null;
  chartAnalyses: Record<string, ChartAnalysisEntry>;
  scannerData: ScannerData | null;
  offensiveExposure: number;
  loading: boolean;
  addStock: (stock: Stock) => void;
  removeStock: (ticker: string) => void;
  moveBucket: (ticker: string) => void;
  updateScore: (ticker: string, key: ScoreKey, value: number) => void;
  updateExplanations: (ticker: string, explanations: ScoreExplanations) => void;
  updateLastScored: (ticker: string, timestamp: string) => void;
  updatePrice: (ticker: string, price: number) => void;
  updateSector: (ticker: string, sector: string) => void;
  updateHealthData: (ticker: string, healthData: HealthData) => void;
  updateTechnicals: (ticker: string, technicals: TechnicalIndicators, riskAlert: RiskAlert) => void;
  updateWeight: (ticker: string, weight: number) => void;
  updateFundData: (ticker: string, fundData: FundData) => void;
  updateStockFields: (ticker: string, fields: Partial<Stock>) => void;
  setBrief: (brief: MorningBrief) => void;
  setChartAnalysis: (ticker: string, entry: ChartAnalysisEntry) => void;
  clearChartAnalysis: (ticker: string) => void;
  setScannerData: (data: ScannerData) => void;
  updateMarketData: (updates: Partial<MarketData>) => void;
  getStock: (ticker: string) => ScoredStock | undefined;
  portfolioStocks: ScoredStock[];
  watchlistStocks: ScoredStock[];
  pimModels: PimModelData;
  updatePimModels: (data: PimModelData) => void;
  rebalanceStockWeights: (holdings: PimHolding[], extraStock?: Stock, groupId?: string) => PimHolding[];
  toggleModelEligibility: (ticker: string, groupId: string, eligible: boolean) => void;
  updateModelWeight: (ticker: string, groupId: string, weight: number) => void;
  pimPortfolioState: PimPortfolioState;
  updatePimPortfolioState: (data: PimPortfolioState) => void;
  getGroupState: (groupId: string) => PimModelGroupState;
  uiPrefs: Record<string, string>;
  setUiPref: (key: string, value: string) => void;
  analystSnapshots: AnalystSnapshots;
  getAnalystSnapshot: (ticker: string) => TickerSnapshot | undefined;
  updateAnalystSnapshot: (ticker: string, next: TickerSnapshot | undefined) => void;
  analystReports: AnalystReports;
  getAnalystReports: (ticker: string) => TickerReports | undefined;
  /** Upload + extract + persist an analyst report PDF for (ticker, source).
   *  On success: stores the PDF dataUrl at pm:analyst-report-pdf:<id>, updates
   *  pm:analyst-reports with the extracted metadata, and merges the extracted
   *  rating/target/asOf into pm:analyst-snapshots[ticker][source]. */
  uploadAnalystReport: (ticker: string, source: "rbc" | "jpm", dataUrl: string, label: string) => Promise<{ ok: true; extracted: ExtractedReport } | { ok: false; error: string }>;
  /** Remove the stored report and the PDF dataUrl. Leaves the snapshot
   *  fields alone — the user can still edit the values manually. */
  removeAnalystReport: (ticker: string, source: "rbc" | "jpm") => Promise<void>;
  /** Convert an existing analyst target from a given currency to the stock's
   *  trading currency. Uses live FX from Yahoo. No re-extraction needed. */
  convertAnalystTarget: (ticker: string, source: "rbc" | "jpm", fromCurrency: string) => Promise<void>;
  /** Detect the trading currency for a ticker (from Yahoo or heuristic). */
  tickerCurrency: (ticker: string) => string;
  /** Immediately persist any pending debounced stock data to Redis.
   *  Call after batch operations (Score All, Refresh All) to guarantee
   *  data is saved before the user navigates away. Returns a Promise. */
  flushStocks: () => Promise<void>;
  /**
   * Fast global price refresh — fetches current prices for every ticker
   * in `stocks` PLUS every ticker referenced in the Research page blob
   * (Newton Upticks, Fundstrat large + SMID lists, RBC Canadian + US
   * Focus, Alpha Picks). Single batched /api/prices call, single
   * setStocks update, single optional PUT back to pm:research for the
   * blob entries that store prices inline (newtonUpticks, alphaPicks).
   *
   * Deliberately scoped:
   *   - NO fund-data deep refresh, sub-fund crawl, or technicals — the
   *     heavier flow stays on PortfolioOverview's "Refresh All Data".
   *
   * Resolves to: {
   *   updated:  how many tickers we successfully applied a new price for
   *   total:    how many unique tickers we attempted
   *   missing:  tickers that came back null or zero — surfaced to the
   *             notification tray so the PM knows which symbols Yahoo
   *             refused (typically Fundserv fund codes, delisted names,
   *             or temporarily-throttled requests).
   * }
   */
  refreshAllPrices: () => Promise<{ updated: number; total: number; missing: string[] }>;
  /** Increments each time refreshAllPrices runs — lets the Research page re-pull
   *  its own live prices/names off the single nav "Refresh prices" button. */
  priceRefreshNonce: number;
  /** In-memory previous-close per ticker from the last price fetch (day-change). */
  livePreviousCloses: Record<string, number | null>;
  /**
   * Recompute the deterministic `researchMentions` category for every
   * Portfolio + Watchlist ticker from the current research-scrape
   * caches. Applies the new score + explanation via updateScore +
   * updateExplanations so the category reflects today's mentions
   * without forcing a full Anthropic rescore.
   *
   * Called automatically on initial context hydration, and can be
   * called from the Research page after a scrape lands so the score
   * jumps as soon as the new mentions cache is written.
   */
  refreshResearchMentions: () => Promise<void>;
};

const StockContext = createContext<StockContextType | null>(null);

export function useStocks() {
  const ctx = useContext(StockContext);
  if (!ctx) throw new Error("useStocks must be used within StockProvider");
  return ctx;
}

/* ─── Debounced persist helper ─── */
// Registry of all pending flush functions so beforeunload can fire them all.
const pendingFlushes: Set<() => void> = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", () => {
    for (const flush of pendingFlushes) flush();
  });
}

/**
 * Returns [debouncedPersist, flushNow].
 *
 * debouncedPersist(data) — queues a persist that fires after `delay` ms.
 * flushNow()            — immediately persists the latest queued data
 *                          (if any), cancelling the pending debounce.
 *                          Returns a Promise that resolves when the PUT
 *                          completes, so callers can `await flushNow()`
 *                          at the end of a batch operation.
 *
 * On beforeunload, all pending debounces auto-flush via fetch+keepalive
 * (sendBeacon has a ~64KB limit that the stocks blob can exceed).
 */
function useDebouncedPersist(url: string, bodyKey: string, delay = 500): [
  (data: unknown) => void,
  () => Promise<void>,
  () => boolean,
] {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestData = useRef<unknown>(null);

  // Flush function: immediately persists the latest data if a debounce is pending.
  const flush = useCallback((): Promise<void> => {
    if (timer.current && latestData.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
      const body = JSON.stringify({ [bodyKey]: latestData.current });
      latestData.current = null;
      // fetch with keepalive works during unload and handles large payloads
      // better than sendBeacon (which has a ~64KB limit — the stocks blob
      // with explanations can be 500KB+).
      return fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
        keepalive: true,
      }).then(() => {}).catch((e) => console.error(`Failed to flush ${bodyKey}:`, e));
    }
    return Promise.resolve();
  }, [url, bodyKey]);

  // Register/unregister the flush function in the global registry.
  // The beforeunload handler calls these synchronously, so the fetch
  // fires but we can't await it — keepalive ensures the browser doesn't
  // cancel it on navigation.
  useEffect(() => {
    const syncFlush = () => { flush(); };
    pendingFlushes.add(syncFlush);
    return () => { pendingFlushes.delete(syncFlush); };
  }, [flush]);

  const debounced = useCallback(
    (data: unknown) => {
      latestData.current = data;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        latestData.current = null;
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [bodyKey]: data }),
        }).catch((e) => console.error(`Failed to persist ${bodyKey}:`, e));
      }, delay);
    },
    [url, bodyKey, delay]
  );

  // True when a write is queued but not yet flushed — i.e. there are local
  // edits not yet in Redis. Used to gate the focus-refetch so a background
  // refresh never clobbers unsaved local changes.
  const isPending = useCallback(() => timer.current !== null, []);

  return [debounced, flush, isPending];
}

export function StockProvider({ children }: { children: React.ReactNode }) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [marketData, setMarketData] = useState<MarketData>(defaultMarketData);
  const [brief, setBriefState] = useState<MorningBrief | null>(null);
  const [chartAnalyses, setChartAnalysesState] = useState<Record<string, ChartAnalysisEntry>>({});
  const [scannerData, setScannerDataState] = useState<ScannerData | null>(null);
  const [pimModels, setPimModelsState] = useState<PimModelData>({ groups: pimModelSeedFallback });
  // Authoritative model baseline (per-group profile %s, cad/usd splits, intended
  // holdings + weightInClass). Hydrated from pm:pim-model-baseline on mount;
  // the seed import is only the synchronous initial value for the first render.
  const [pimBaseline, setPimBaseline] = useState<PimModelGroup[]>(pimModelSeedFallback);
  const [pimPortfolioState, setPimPortfolioState] = useState<PimPortfolioState>({ groupStates: [], lastUpdated: "" });
  const [uiPrefs, setUiPrefsState] = useState<Record<string, string>>({});
  // Bumped by refreshAllPrices; the Research page watches it to re-pull its own
  // local price/name state so the nav "Refresh prices" button covers it too.
  const [priceRefreshNonce, setPriceRefreshNonce] = useState(0);
  // In-memory (not persisted) previous-close per ticker, captured from the last
  // /api/prices fetch. Feeds the Rankings "Day" column's live day-change.
  const [livePreviousCloses, setLivePreviousCloses] = useState<Record<string, number | null>>({});
  const [analystSnapshots, setAnalystSnapshotsState] = useState<AnalystSnapshots>({});
  const [analystReports, setAnalystReportsState] = useState<AnalystReports>({});
  const [loading, setLoading] = useState(true);

  const [persistStocks, flushStocks, isStocksPersistPending] = useDebouncedPersist("/api/kv/stocks", "stocks");
  // Market data persists immediately (not debounced) since updates are explicit save actions
  const persistMarket = useCallback((data: unknown) => {
    fetch("/api/kv/market", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: data }),
    }).catch((e) => console.error("Failed to persist market:", e));
  }, []);
  const [persistBrief] = useDebouncedPersist("/api/kv/brief", "brief", 100);
  const [persistChartAnalyses] = useDebouncedPersist("/api/kv/chart-analysis", "chartAnalyses", 300);
  const [persistScanner] = useDebouncedPersist("/api/kv/scanner", "scanner", 300);
  // Custom persist for pim-models (sends full object, not wrapped in key)
  const persistPim = useCallback((data: PimModelData) => {
    fetch("/api/kv/pim-models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).catch((e) => console.error("Failed to persist pim-models:", e));
  }, []);
  const persistPortfolioState = useCallback((data: PimPortfolioState) => {
    fetch("/api/kv/pim-portfolio-state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }).catch((e) => console.error("Failed to persist pim-portfolio-state:", e));
  }, []);
  const [persistUiPrefs] = useDebouncedPersist("/api/kv/ui-prefs", "uiPrefs", 300);
  const [persistAnalystSnapshots] = useDebouncedPersist("/api/kv/analyst-snapshots", "snapshots", 400);
  const persistAnalystReports = useCallback((data: AnalystReports) => {
    fetch("/api/kv/analyst-reports", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reports: data }),
    }).catch((e) => console.error("Failed to persist analyst-reports:", e));
  }, []);

  /* ─── Load from KV on mount ─── */
  useEffect(() => {
    Promise.all([
      fetch("/api/kv/stocks").then((r) => r.json()).catch(() => ({ stocks: [] })),
      fetch("/api/kv/market").then((r) => r.json()).catch(() => ({ market: defaultMarketData })),
      fetch("/api/kv/brief").then((r) => r.json()).catch(() => ({ brief: null })),
      fetch("/api/kv/chart-analysis").then((r) => r.json()).catch(() => ({ chartAnalyses: {} })),
      fetch("/api/kv/scanner").then((r) => r.json()).catch(() => ({ scanner: null })),
      fetch("/api/kv/pim-models").then((r) => r.json()).catch(() => ({ groups: pimModelSeedFallback })),
      fetch("/api/kv/pim-portfolio-state").then((r) => r.json()).catch(() => ({ groupStates: [], lastUpdated: "" })),
      fetch("/api/kv/ui-prefs").then((r) => r.json()).catch(() => ({ uiPrefs: {} })),
      fetch("/api/kv/analyst-snapshots").then((r) => r.json()).catch(() => ({ snapshots: {} })),
      fetch("/api/kv/analyst-reports").then((r) => r.json()).catch(() => ({ reports: {} })),
      fetch("/api/kv/pim-model-baseline").then((r) => r.json()).catch(() => ({ baseline: null })),
    ]).then(async ([stocksRes, marketRes, briefRes, chartRes, scannerRes, pimRes, portfolioStateRes, uiPrefsRes, analystSnapshotsRes, analystReportsRes, baselineRes]) => {
      // Resolve the authoritative baseline (Redis first, seed fallback) and
      // promote it into state for all downstream rebalance math. The seed
      // fallback runs only if pm:pim-model-baseline is missing or unreadable.
      const baselineGroups: PimModelGroup[] =
        baselineRes?.baseline?.groups && Array.isArray(baselineRes.baseline.groups) && baselineRes.baseline.groups.length > 0
          ? (baselineRes.baseline.groups as PimModelGroup[])
          : pimModelSeedFallback;
      setPimBaseline(baselineGroups);
      const rawLoadedStocks: Stock[] = stocksRes.stocks || [];
      const { migrated: loadedStocks, changed: scoresMigrated } = migrateStockScores(rawLoadedStocks);
      setStocks(loadedStocks);
      if (scoresMigrated) persistStocks(loadedStocks);
      if (marketRes.market) setMarketData({ ...defaultMarketData, ...marketRes.market });
      if (briefRes.brief) setBriefState(briefRes.brief);
      if (chartRes.chartAnalyses) setChartAnalysesState(chartRes.chartAnalyses);
      if (scannerRes.scanner) setScannerDataState(scannerRes.scanner);
      if (pimRes.groups) {
        // Fix FUNDSERV currencies: look up authoritative currency from seed data
        let pimFixed = false;
        const fixedPim = {
          ...pimRes,
          groups: pimRes.groups.map((g: { id: string; holdings: Array<{ symbol: string; currency: string }> }) => ({
            ...g,
            holdings: g.holdings.map((h: { symbol: string; currency: string }) => {
              const base = h.symbol.replace(/-T$/, "");
              if (/^[A-Z]{2,4}\d{2,5}$/i.test(base)) {
                // Look up the correct currency from the loaded baseline (Redis first, seed fallback)
                let seedCurrency: "CAD" | "USD" = "CAD"; // default fallback
                for (const sg of baselineGroups) {
                  const seedHolding = sg.holdings.find((sh) => sh.symbol === h.symbol || sh.symbol === base);
                  if (seedHolding) { seedCurrency = seedHolding.currency; break; }
                }
                if (h.currency !== seedCurrency) {
                  pimFixed = true;
                  return { ...h, currency: seedCurrency };
                }
              }
              return h;
            }),
          })),
        };
        setPimModelsState(fixedPim);
        if (pimFixed) persistPim(fixedPim);
      }
      if (portfolioStateRes.groupStates) setPimPortfolioState(portfolioStateRes);
      if (uiPrefsRes.uiPrefs) setUiPrefsState(uiPrefsRes.uiPrefs);
      if (analystSnapshotsRes.snapshots) setAnalystSnapshotsState(analystSnapshotsRes.snapshots);
      if (analystReportsRes.reports) setAnalystReportsState(analystReportsRes.reports);
      setLoading(false);

      // Backfill missing names from Yahoo Finance for all stocks
      // Names are considered missing if name equals ticker (e.g. "AAPL" instead of "Apple Inc.")
      const needsNameBackfill = loadedStocks.filter((s) => !s.name || s.name === s.ticker);
      if (needsNameBackfill.length > 0) {
        try {
          // Fetch all stock tickers to get names and sectors
          const allTickers = loadedStocks.map((s) => s.ticker).join(",");
          const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(allTickers)}`);
          if (res.ok) {
            const data = await res.json();
            setStocks((prev) => {
              let changed = false;
              const next = prev.map((s) => {
                const newName = data.names?.[s.ticker];
                const newSector = data.sectors?.[s.ticker];
                const shouldUpdateName = newName && (!s.name || s.name === s.ticker);
                const isFund = s.instrumentType === "etf" || s.instrumentType === "mutual-fund";
                const shouldUpdateSector = !isFund && newSector && newSector !== s.sector;
                if (shouldUpdateName || shouldUpdateSector) {
                  changed = true;
                  return {
                    ...s,
                    ...(shouldUpdateName ? { name: newName } : {}),
                    ...(shouldUpdateSector ? { sector: newSector } : {}),
                  };
                }
                return s;
              });
              if (changed) persistStocks(next);
              return changed ? next : prev;
            });
          }
        } catch { /* backfill is best-effort */ }
      }

      // Backfill fund data for portfolio funds/ETFs that are missing it
      const needsFundData = loadedStocks.filter(
        (s) => s.bucket === "Portfolio" &&
          (s.instrumentType === "etf" || s.instrumentType === "mutual-fund") &&
          !s.fundData
      );
      if (needsFundData.length > 0) {
        // Fetch fund data sequentially to avoid rate limits
        for (const fund of needsFundData) {
          try {
            const res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(fund.ticker)}`);
            if (res.ok) {
              const data = await res.json();
              if (data.fundData) {
                setStocks((prev) => {
                  const next = prev.map((s) => {
                    if (s.ticker !== fund.ticker) return s;
                    const existing = s.fundData;
                    const merged = { ...data.fundData };
                    // Preserve user-provided holdings if API returned none
                    if (!merged.topHoldings?.length && existing?.topHoldings?.length) {
                      merged.topHoldings = existing.topHoldings;
                      merged.sectorWeightings = existing.sectorWeightings;
                      merged.holdingsLastUpdated = existing.holdingsLastUpdated;
                      merged.holdingsSource = existing.holdingsSource;
                    }
                    if (existing?.holdingsUrl && !merged.holdingsUrl) {
                      merged.holdingsUrl = existing.holdingsUrl;
                    }
                    if (existing?.holdingsLastUpdated && !merged.holdingsLastUpdated) {
                      merged.holdingsLastUpdated = existing.holdingsLastUpdated;
                    }
                    if (merged.topHoldings?.length && !merged.holdingsLastUpdated) {
                      merged.holdingsLastUpdated = new Date().toISOString();
                    }
                    return {
                      ...s,
                      fundData: merged,
                      ...(data.name && (!s.name || s.name === s.ticker) ? { name: data.name } : {}),
                    };
                  });
                  persistStocks(next);
                  return next;
                });
              }
            }
          } catch { /* best effort */ }
        }
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-patch computed category scores before computing totals so the
  // dashboard, stock page, and every consumer sees current values without
  // requiring a full rescore. The persisted scores in pm:stocks may be stale
  // (old rounding, pre-FactSet fallback, etc.).
  const scoredStocks = useMemo(
    () => stocks.map((s) => {
      const overrides: Partial<Record<ScoreKey, number>> = {};
      // analystConsensus: live from analyst snapshot
      const snap = getSnapshotForTicker(analystSnapshots, s.ticker);
      overrides.analystConsensus = computeAnalystConsensus(snap, s.price).score;
      // aiRating: live from BoostedAI fields
      const ai = mapBoostedAiToAiRating(s.boostedAi ?? null, (s.boostedAiConsensus as BoostedAiConsensus) ?? null);
      if (ai != null) overrides.aiRating = ai;
      // relativeStrength: live from SIA SMAX
      const rs = mapSmaxToRelativeStrength(s.sia ?? null);
      if (rs != null) overrides.relativeStrength = rs;

      const patched = { ...s, scores: { ...s.scores, ...overrides } };
      return computeScores(patched, marketData);
    }),
    [stocks, marketData, analystSnapshots]
  );

  const portfolioStocks = useMemo(
    () => scoredStocks.filter((s) => s.bucket === "Portfolio").sort((a, b) => b.adjusted - a.adjusted),
    [scoredStocks]
  );

  const watchlistStocks = useMemo(
    () => scoredStocks.filter((s) => s.bucket === "Watchlist").sort((a, b) => b.adjusted - a.adjusted),
    [scoredStocks]
  );

  const offensiveExposure = useMemo(
    () =>
      scoredStocks
        .filter((s) => s.bucket === "Portfolio" && isScoreable(s) && isOffensiveSector(s.sector))
        .reduce((sum, s) => sum + s.weights.portfolio, 0),
    [scoredStocks]
  );

  /* ─── PIM model helpers: determine asset class ─── */
  const detectAssetClass = useCallback((stock: Stock): "fixedIncome" | "equity" | "alternative" => {
    const sectorLower = (stock.sector || "").toLowerCase();
    const nameLower = (stock.name || stock.ticker).toLowerCase();
    if (stock.instrumentType === "etf" || stock.instrumentType === "mutual-fund") {
      if (sectorLower.includes("bond") || sectorLower.includes("fixed") || nameLower.includes("bond") || nameLower.includes("fixed income")) {
        return "fixedIncome";
      }
      if (sectorLower.includes("alternative") || nameLower.includes("alternative") || nameLower.includes("premium yield") || nameLower.includes("premium incom") || nameLower.includes("hedge") || nameLower.includes("option income") || nameLower.includes("option writing") || nameLower.includes("covered call")) {
        return "alternative";
      }
    }
    return "equity";
  }, []);

  /* ─── Helper: is the instrument a stock (not ETF/MF)? ─── */
  const isStock = useCallback((s: Stock | { instrumentType?: string }) => {
    return !s.instrumentType || s.instrumentType === "stock";
  }, []);

  /* ─── Helper: ticker matching across -T / .TO variants ─── */
  const tickerMatch = useCallback((a: string, b: string) => {
    return a === b || a.replace("-T", ".TO") === b.replace("-T", ".TO");
  }, []);

  /* ─── Helper: detect currency from ticker ─── */
  // Preferred source: the `currency` field from Yahoo (stored on each Stock
  // object from /api/prices responses). Fallback heuristic for tickers that
  // haven't been price-fetched yet:
  //   .U suffix = USD-denominated Canadian-listed ETF
  //   -T / .TO  = CAD
  //   FUNDSERV  = pim-seed lookup, default CAD
  //   everything else = USD
  const tickerCurrency = useCallback((ticker: string): string => {
    // 1) Check stored Yahoo currency on the stock object (most authoritative)
    const stock = stocks.find((s) => s.ticker === ticker || s.ticker.toUpperCase() === ticker.toUpperCase());
    if (stock?.currency) return stock.currency;
    // 2) Heuristic fallbacks
    if (ticker.endsWith(".U")) return "USD";
    if (ticker.endsWith("-T") || ticker.endsWith(".TO")) return "CAD";
    // FUNDSERV codes — look up in baseline (Redis-backed, seed fallback) for authoritative currency
    const base = ticker.replace(/-T$/, "");
    if (/^[A-Z]{2,4}\d{2,5}$/i.test(base)) {
      for (const g of pimBaseline) {
        const seedHolding = g.holdings.find((h) => h.symbol === ticker || h.symbol === base);
        if (seedHolding) return seedHolding.currency;
      }
      return "CAD";
    }
    return "USD";
  }, [stocks, pimBaseline]);

  /* ─── Rebalance: individual stocks keep fixed weight, freed weight → Core ETFs ─── */
  const rebalanceStockWeights = useCallback((holdings: PimHolding[], extraStock?: Stock, groupId?: string): PimHolding[] => {
    // Reference per-stock weight from PIM base model (Redis-backed baseline, seed fallback)
    const pimBaseGroup = pimBaseline.find((g) => g.id === "pim");
    const refPerStock = 0.018182; // PIM baseline default for individual stocks

    // Build a set of individual stock symbols from the PIM base model seed
    // Stocks are equity holdings with weightInClass === refPerStock (the fixed per-stock weight)
    const seedStockSymbols = new Set<string>();
    if (pimBaseGroup) {
      for (const h of pimBaseGroup.holdings) {
        if (h.assetClass === "equity" && Math.abs(h.weightInClass - refPerStock) < 0.001) {
          seedStockSymbols.add(h.symbol);
          seedStockSymbols.add(h.symbol.replace(/-T$/, ".TO"));
          seedStockSymbols.add(h.symbol.replace(/\.TO$/, "-T"));
        }
      }
    }
    // Also include any portfolio stocks added after seed
    for (const s of stocks) {
      if (s.bucket === "Portfolio" && isStock(s)) {
        seedStockSymbols.add(s.ticker);
        seedStockSymbols.add(s.ticker.replace(".TO", "-T"));
        seedStockSymbols.add(s.ticker.replace("-T", ".TO"));
      }
    }
    if (extraStock && isStock(extraStock)) {
      seedStockSymbols.add(extraStock.ticker);
      seedStockSymbols.add(extraStock.ticker.replace(".TO", "-T"));
      seedStockSymbols.add(extraStock.ticker.replace("-T", ".TO"));
    }

    // Determine whether an equity ETF/MF holding should be Alpha-locked (weight
    // preserved through rebalance) vs Core (absorbs residual). The PRIMARY
    // mechanism is the per-stock `designation` field in pm:stocks, set by the
    // user via the Role toggle in the Stocks tab. Default-undefined designation
    // is treated as Alpha — this matches both the UI default (PortfolioOverview
    // renders `(s.designation || "alpha") === "core"`) and types.ts which
    // documents the field as "default alpha". Only an EXPLICIT "core" tag
    // makes a holding residual-absorbing.
    //
    // Behavior decision tree:
    //   - pm:stocks entry has designation === "core"   → NOT locked (Core ETF)
    //   - pm:stocks entry exists, any other state      → Alpha-locked
    //   - no pm:stocks entry at all (rare/stale data)  → legacy fallback
    const isAlphaLockedHolding = (symbol: string): boolean => {
      const stockEntry = stocks.find((s) =>
        s.ticker === symbol ||
        s.ticker.replace(/\.TO$/, "-T") === symbol ||
        s.ticker.replace(/-T$/, ".TO") === symbol,
      );
      if (stockEntry) {
        // Any tagged-or-untagged pm:stocks entry locks UNLESS explicitly "core"
        return stockEntry.designation !== "core";
      }
      // No pm:stocks entry at all → legacy fallback
      return LEGACY_LOCKED_EQUITY_SYMBOLS.has(symbol);
    };

    const equityHoldings = holdings.filter((h) => h.assetClass === "equity");
    const nonEquity = holdings.filter((h) => h.assetClass !== "equity");

    // Split equity holdings into three pools:
    //   1) individual stocks — locked at refPerStock
    //   2) Alpha-tagged funds — pass-through, keep current weightInClass
    //   3) Core-tagged ETFs — absorb residual equity weight proportionally
    const stockHoldings = equityHoldings.filter((h) => seedStockSymbols.has(h.symbol));
    const lockedHoldings = equityHoldings.filter(
      (h) => !seedStockSymbols.has(h.symbol) && isAlphaLockedHolding(h.symbol),
    );
    const etfHoldings = equityHoldings.filter(
      (h) => !seedStockSymbols.has(h.symbol) && !isAlphaLockedHolding(h.symbol),
    );

    if (stockHoldings.length === 0 && etfHoldings.length === 0 && lockedHoldings.length === 0) return holdings;

    // Each stock keeps the SAME per-stock weight as the PIM base model
    const stockTotal = refPerStock * stockHoldings.length;

    // Locked specialty funds keep their existing weightInClass untouched
    const lockedTotal = lockedHoldings.reduce((s, h) => s + h.weightInClass, 0);

    // ── Residual rule: Core/Alpha fixed, individual stocks fill the gap ──
    // For EVERY model: the Core ETFs and Alpha funds keep their FIXED,
    // manually-set weightInClass, and the individual stocks equal-weight
    // whatever residual is left over (residual / N). This is the mirror
    // image of the legacy default rule below (stocks locked at refPerStock,
    // Core ETFs absorb the residual), which now only runs as a fallback
    // when a model has no individual stocks (nothing could absorb the
    // residual), so the asset class can never drop below 100%.
    //
    // It is a no-op on currently-balanced data — today's Core weights
    // already equal the residual, so perStock resolves right back to
    // refPerStock and no rebalance fires on deploy — and the two rules only
    // diverge once a Core/Alpha weight is edited, at which point that weight
    // sticks and the stocks flex to keep the class at 100%. (`groupId` is
    // retained on the signature for call-site auditability / future
    // per-model hooks even though the rule is now uniform.)
    if (stockHoldings.length > 0) {
      const coreTotalFixed = etfHoldings.reduce((s, h) => s + h.weightInClass, 0);
      const stockResidual = Math.max(0, 1.0 - coreTotalFixed - lockedTotal);
      const perStock = parseFloat((stockResidual / stockHoldings.length).toFixed(6));
      return [
        ...nonEquity,
        ...lockedHoldings,             // Alpha funds — weightInClass preserved
        ...etfHoldings,                // Core ETFs — manually-set weight preserved
        ...stockHoldings.map((h) => ({ ...h, weightInClass: perStock })),
      ];
    }

    // Core (unlocked) ETFs absorb the remainder proportionally per PIM seed ratios
    const seedEtfWeights = new Map<string, number>();
    if (pimBaseGroup) {
      for (const h of pimBaseGroup.holdings) {
        if (
          h.assetClass === "equity" &&
          !seedStockSymbols.has(h.symbol) &&
          !isAlphaLockedHolding(h.symbol)
        ) {
          seedEtfWeights.set(h.symbol, h.weightInClass);
        }
      }
    }

    const etfTotal = Math.max(0, 1.0 - stockTotal - lockedTotal);
    const seedEtfTotal = [...seedEtfWeights.values()].reduce((s, v) => s + v, 0);

    const rebalancedEtfs = etfHoldings.map((h) => {
      // Use seed ratio if available, otherwise preserve current ratio
      const seedWeight = seedEtfWeights.get(h.symbol);
      const ratio = seedWeight != null && seedEtfTotal > 0
        ? seedWeight / seedEtfTotal
        : (etfHoldings.length > 0 ? h.weightInClass / (etfHoldings.reduce((s, e) => s + e.weightInClass, 0) || 1) : 0);
      return { ...h, weightInClass: parseFloat((ratio * etfTotal).toFixed(6)) };
    });

    return [
      ...nonEquity,
      ...lockedHoldings, // untouched — weightInClass preserved exactly
      ...rebalancedEtfs,
      ...stockHoldings.map((h) => ({ ...h, weightInClass: refPerStock })),
    ];
  }, [stocks, isStock, pimBaseline]);

  /* ─── Helper: get balanced asset class allocation for a group ─── */
  const getBalancedAlloc = useCallback((group: { profiles: Partial<Record<string, { fixedIncome: number; equity: number; alternatives: number }>> }, assetClass: "fixedIncome" | "equity" | "alternative"): number => {
    const balanced = group.profiles.balanced;
    if (!balanced) return 0;
    if (assetClass === "fixedIncome") return balanced.fixedIncome;
    if (assetClass === "equity") return balanced.equity;
    if (assetClass === "alternative") return balanced.alternatives;
    return 0;
  }, []);

  /* ─── Auto-add to PIM models when stock is added ─── */
  const addToPimModels = useCallback((stock: Stock) => {
    // Defensive guard: Watchlist stocks never belong in PIM models.
    // This backstops addStock / moveBucket callers.
    if (stock.bucket !== "Portfolio") return;
    setPimModelsState((prev) => {
      const assetClass = detectAssetClass(stock);
      // PIM models only support CAD/USD — cast the general currency string
      const currency = tickerCurrency(stock.ticker) as "CAD" | "USD";
      const eligibility = stock.modelEligibility || {};

      const updatedGroups = prev.groups.map((group) => {
        // Skip if stock is explicitly ineligible for this model
        if (eligibility[group.id] === false) return group;

        // Skip if already in this group
        if (group.holdings.some((h) => tickerMatch(h.symbol, stock.ticker))) return group;

        // For ETFs/MFs: derive weightInClass from per-model weight (or fallback to portfolio weight)
        // weightInClass = manualWeight / balancedAssetClassAllocation
        let initialWeightInClass = 0;
        if (!isStock(stock)) {
          const manualWeight = stock.modelWeights?.[group.id] ?? stock.weights.portfolio;
          if (manualWeight > 0) {
            const balancedAlloc = getBalancedAlloc(group, assetClass);
            if (balancedAlloc > 0) {
              initialWeightInClass = parseFloat(((manualWeight / 100) / balancedAlloc).toFixed(6));
            }
          }
        }

        // Add the new holding
        const newHoldings = [...group.holdings, {
          name: (stock.name || stock.ticker).toUpperCase(),
          symbol: stock.ticker,
          currency,
          assetClass,
          weightInClass: initialWeightInClass,
        }];

        // For individual stocks: rebalance all stocks to equal weight
        // For ETFs/MFs: weight is derived from manual input, just rebalance stocks
        if (isStock(stock)) {
          return { ...group, holdings: rebalanceStockWeights(newHoldings, stock, group.id) };
        } else {
          // Rebalance individual stocks in case ETF is in equity class
          return { ...group, holdings: rebalanceStockWeights(newHoldings, undefined, group.id) };
        }
      });

      const updated = { ...prev, groups: updatedGroups, lastUpdated: new Date().toISOString() };
      persistPim(updated);
      return updated;
    });
  }, [persistPim, detectAssetClass, isStock, tickerMatch, tickerCurrency, rebalanceStockWeights, getBalancedAlloc]);

  /* ─── Auto-remove from PIM models when stock is removed ─── */
  const removeFromPimModels = useCallback((ticker: string) => {
    setPimModelsState((prev) => {
      const updatedGroups = prev.groups.map((group) => {
        const holdingIdx = group.holdings.findIndex((h) => tickerMatch(h.symbol, ticker));
        if (holdingIdx === -1) return group;

        const remainingHoldings = group.holdings.filter((_, i) => i !== holdingIdx);
        // Rebalance individual stocks to redistribute freed equity weight
        return { ...group, holdings: rebalanceStockWeights(remainingHoldings, undefined, group.id) };
      });

      const updated = { ...prev, groups: updatedGroups, lastUpdated: new Date().toISOString() };
      persistPim(updated);
      return updated;
    });
  }, [persistPim, tickerMatch, rebalanceStockWeights]);

  /* ─── Stock mutations (optimistic + persist) ─── */
  const addStock = useCallback((stock: Stock) => {
    setStocks((prev) => {
      const next = [stock, ...prev];
      persistStocks(next);
      return next;
    });
    // Auto-add to eligible PIM models — Portfolio bucket ONLY.
    // Watchlist names must never flow into PIM Model / Positioning /
    // performance calculations. They are research candidates, not
    // actual holdings.
    if (stock.bucket === "Portfolio") {
      addToPimModels(stock);
    }
  }, [persistStocks, addToPimModels]);

  const removeStock = useCallback((ticker: string) => {
    setStocks((prev) => {
      const next = prev.filter((s) => s.ticker !== ticker);
      persistStocks(next);
      return next;
    });
    // Auto-remove from PIM models
    removeFromPimModels(ticker);
  }, [persistStocks, removeFromPimModels]);

  const moveBucket = useCallback((ticker: string) => {
    const stock = stocks.find((s) => s.ticker === ticker);
    const wasPortfolio = stock?.bucket === "Portfolio";
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker
          ? { ...s, bucket: (s.bucket === "Portfolio" ? "Watchlist" : "Portfolio") as "Portfolio" | "Watchlist", weights: { portfolio: s.bucket === "Portfolio" ? 0 : 2 } }
          : s
      );
      persistStocks(next);
      return next;
    });

    // Sync with PIM models: remove when moving to Watchlist, add when moving to Portfolio
    if (wasPortfolio) {
      removeFromPimModels(ticker);
    } else if (stock) {
      // Pass the post-flip stock so downstream logic sees bucket="Portfolio"
      addToPimModels({ ...stock, bucket: "Portfolio" });
    }
  }, [stocks, persistStocks, removeFromPimModels, addToPimModels]);

  const updateScore = useCallback((ticker: string, key: ScoreKey, value: number) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, scores: { ...s.scores, [key]: value } } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updateExplanations = useCallback((ticker: string, explanations: ScoreExplanations) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, explanations: { ...s.explanations, ...explanations } } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updateLastScored = useCallback((ticker: string, timestamp: string) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, lastScored: timestamp } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updatePrice = useCallback((ticker: string, price: number) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, price } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  /**
   * Bulk price refresh for the global nav Refresh button. POSTs all
   * tickers in a single /api/prices batch and applies the prices via
   * one setStocks call (rather than N individual updatePrice calls,
   * which would queue N renders and N debounced persists).
   *
   * Skips fund-data deep refresh, sub-fund crawl, technicals, and
   * riskAlert by design — those are the PortfolioOverview Refresh All
   * Data button's job. This one is meant to be fast and runnable from
   * anywhere in the app.
   */
  const refreshAllPrices = useCallback(async (): Promise<{ updated: number; total: number; missing: string[] }> => {
    // ── 1. Collect stock tickers (Portfolio + Watchlist + funds/ETFs) ──
    const stockTickers = stocks.map((s) => s.ticker);

    // ── 2. Pull research blob tickers ──
    // Tries to GET pm:research; if the call fails we just refresh
    // stocks-only (degraded mode) rather than blocking the user.
    type ResearchEntry = { ticker?: string; price?: number };
    type ResearchBlob = {
      newtonUpticks?: ResearchEntry[];
      fundstratTop?: ResearchEntry[];
      fundstratBottom?: ResearchEntry[];
      fundstratSmidTop?: ResearchEntry[];
      fundstratSmidBottom?: ResearchEntry[];
      rbcCanadianFocus?: ResearchEntry[];
      rbcUsFocus?: ResearchEntry[];
      alphaPicks?: ResearchEntry[];
    };
    let research: ResearchBlob | null = null;
    let researchTickers: string[] = [];
    try {
      const r = await fetch("/api/kv/research", { cache: "no-store" });
      if (r.ok) {
        const blob = (await r.json()) as ResearchBlob;
        research = blob;
        const collect = (arr: ResearchEntry[] | undefined) =>
          (arr ?? []).map((e) => e?.ticker).filter((t): t is string => typeof t === "string" && t.length > 0);
        researchTickers = [
          ...collect(blob.newtonUpticks),
          ...collect(blob.fundstratTop),
          ...collect(blob.fundstratBottom),
          ...collect(blob.fundstratSmidTop),
          ...collect(blob.fundstratSmidBottom),
          ...collect(blob.rbcCanadianFocus),
          ...collect(blob.rbcUsFocus),
          ...collect(blob.alphaPicks),
        ];
      }
    } catch { /* non-fatal — refresh stocks-only */ }

    // ── 3. Dedupe combined ticker set ──
    const allTickers = Array.from(new Set([...stockTickers, ...researchTickers]));
    if (allTickers.length === 0) return { updated: 0, total: 0, missing: [] };

    // ── 4. Batched /api/prices fetch (route caps at 250) ──
    let priceMap: Record<string, number | null> = {};
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: allTickers }),
      });
      if (!res.ok) {
        // Total failure — every ticker is "missing".
        return { updated: 0, total: allTickers.length, missing: allTickers };
      }
      const data = await res.json();
      priceMap = (data.prices ?? {}) as Record<string, number | null>;
      // Capture previous closes (in-memory only, not persisted) so the Rankings
      // "Day" column can show live day-change. Merge so a partial refresh keeps
      // prior values.
      if (data.previousCloses && typeof data.previousCloses === "object") {
        setLivePreviousCloses((prev) => ({ ...prev, ...(data.previousCloses as Record<string, number | null>) }));
      }
    } catch {
      return { updated: 0, total: allTickers.length, missing: allTickers };
    }

    // ── 5. Apply to pm:stocks via a single setStocks update ──
    let applied = 0;
    setStocks((prev) => {
      const next = prev.map((s) => {
        const p = priceMap[s.ticker];
        if (typeof p === "number" && p > 0 && p !== s.price) {
          applied++;
          return { ...s, price: p };
        }
        return s;
      });
      persistStocks(next);
      return next;
    });

    // ── 6. Apply to pm:research for blob entries that carry an inline
    // price (Newton Upticks and Alpha Picks store one; the Idea/RBC
    // lists don't). One PUT only fires if at least one price changed.
    if (research) {
      const patched = { ...research };
      let changed = false;
      const applyPrice = (arr: ResearchEntry[] | undefined): ResearchEntry[] | undefined => {
        if (!Array.isArray(arr)) return arr;
        return arr.map((e) => {
          if (!e?.ticker) return e;
          const p = priceMap[e.ticker];
          if (typeof p === "number" && p > 0 && p !== e.price) {
            changed = true;
            applied++;
            return { ...e, price: p };
          }
          return e;
        });
      };
      patched.newtonUpticks = applyPrice(patched.newtonUpticks);
      patched.alphaPicks = applyPrice(patched.alphaPicks);
      if (changed) {
        try {
          await fetch("/api/kv/research", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patched),
          });
        } catch { /* non-fatal — display will refresh on next page load */ }
      }
    }

    // ── 7. Tickers Yahoo didn't return a usable price for ──
    const missing = allTickers.filter((t) => {
      const p = priceMap[t];
      return p == null || p <= 0;
    });

    // Capture today's SPY hedging snapshot server-side so the nav "Refresh
    // prices" button builds the hedging ledger too — even on days the Hedging
    // tab is never opened. Best-effort, non-blocking (append-only write).
    fetch("/api/hedging/snapshot", { method: "POST" }).catch(() => { /* best-effort */ });

    // Signal any live consumers (e.g. the Research page's local price/name
    // state, and the Hedging tab if open) to re-pull, so the ONE nav "Refresh
    // prices" button also refreshes those views — no separate refresh needed.
    setPriceRefreshNonce((n) => n + 1);
    return { updated: applied, total: allTickers.length, missing };
  }, [stocks, persistStocks]);

  /**
   * Batch-refresh researchMentions across all known tickers from the
   * current research-scrape caches. POSTs to /api/research-mentions
   * (deterministic, no Anthropic spend) and applies each result via
   * updateScore + updateExplanations.
   */
  const refreshResearchMentions = useCallback(async (): Promise<void> => {
    const tickers = stocks.map((s) => s.ticker);
    if (tickers.length === 0) return;
    try {
      const res = await fetch("/api/research-mentions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (!res.ok) return;
      const data = await res.json();
      const results = (data?.results ?? {}) as Record<string, {
        score: number;
        rawDelta: number;
        mentions: Array<{ source: string; label: string; direction: string; analyzedAt?: string }>;
      }>;
      // Apply each ticker's new score + explanation. Wrapped in a
      // single setStocks below would be cleaner perf-wise, but
      // updateScore/updateExplanations already batch through
      // persistStocks's debounce — fine for one-shot updates triggered
      // a few times per session.
      //
      // Imports the pure-display builder from research-mentions-display.ts
      // (NOT research-mentions.ts) — the latter imports the `redis`
      // package, which Node-only modules `net`/`dns` and would crash the
      // client bundle. The display file is intentionally redis-free.
      for (const [tickerKey, result] of Object.entries(results)) {
        // Find the matching stock by case-insensitive ticker match —
        // the API normalises to uppercase, our context may have mixed
        // case (e.g. CN, RY.TO).
        const stock = stocks.find((s) => s.ticker.toUpperCase() === tickerKey);
        if (!stock) continue;
        if (typeof result.score !== "number") continue;
        const explanation = buildResearchMentionsExplanation(stock.ticker, {
          score: result.score,
          rawDelta: result.rawDelta,
          mentions: result.mentions.map((m) => ({
            label: m.label,
            direction: m.direction as "bullish" | "bearish",
            analyzedAt: m.analyzedAt,
          })),
        });
        // Only write when the score OR the explanation actually changed.
        // This matters now that the refresh fires on window focus too —
        // without the guard, every tab-back would persist + re-render the
        // whole stocks blob even when nothing moved.
        const scoreChanged = stock.scores.researchMentions !== result.score;
        const explChanged = stock.explanations?.researchMentions !== explanation;
        if (!scoreChanged && !explChanged) continue;
        if (scoreChanged) updateScore(stock.ticker, "researchMentions", result.score);
        if (explChanged) updateExplanations(stock.ticker, { researchMentions: explanation });
      }
    } catch {
      // Non-fatal — UI just keeps the prior score until next refresh.
    }
  // updateScore / updateExplanations are stable from useCallback; including
  // them satisfies the lint without changing identity.
  }, [stocks, updateScore, updateExplanations]);

  // Auto-refresh researchMentions once stocks have hydrated. Pure
  // Redis read on the server, no Anthropic spend — fires once per
  // session so the category always reflects today's research caches
  // when the dashboard opens. Ref-gated to dodge React-Strict-Mode
  // double-invocations and avoid re-firing on every stocks mutation.
  const mentionsBootstrapRef = useRef(false);
  useEffect(() => {
    if (loading) return;
    if (mentionsBootstrapRef.current) return;
    if (stocks.length === 0) return;
    mentionsBootstrapRef.current = true;
    void refreshResearchMentions();
  }, [loading, stocks.length, refreshResearchMentions]);

  // Re-refresh researchMentions when the user returns to the app (window
  // focus or tab becomes visible). This closes the gap where research was
  // updated in another tab/session while the dashboard stayed open — the
  // category now reflects the latest scrape caches without a full rescore
  // or a page reload. Throttled to once per 30s so rapid tab-switching
  // doesn't spam the (cheap, deterministic) endpoint. The only-when-changed
  // guard inside refreshResearchMentions means no persist/re-render fires
  // unless a score actually moved.
  const lastMentionsRefreshRef = useRef(0);
  useEffect(() => {
    if (loading) return;
    const maybeRefresh = () => {
      if (document.visibilityState === "hidden") return;
      const now = Date.now();
      if (now - lastMentionsRefreshRef.current < 30_000) return;
      lastMentionsRefreshRef.current = now;
      void refreshResearchMentions();
    };
    window.addEventListener("focus", maybeRefresh);
    document.addEventListener("visibilitychange", maybeRefresh);
    return () => {
      window.removeEventListener("focus", maybeRefresh);
      document.removeEventListener("visibilitychange", maybeRefresh);
    };
  }, [loading, refreshResearchMentions]);

  // Re-pull pm:stocks when the user returns to the app (window focus / tab
  // visible). The email-inbox pipeline writes pm:stocks SERVER-SIDE
  // (applyPatchesToRedis), but the client only hydrates stocks once on
  // mount — so an already-open dashboard kept showing pre-import values
  // until a full reload. This closes that gap: switch away and back and the
  // imported SIA / Boosted / MarketEdge values appear automatically.
  //
  // SAFETY (this is the most data-loss-prone path in the app):
  //  - GATED on `!isStocksPersistPending()` — if there are unsaved local
  //    edits queued, we SKIP the refetch entirely so a background refresh
  //    can never overwrite in-flight local changes. The server copy is a
  //    strict superset of what we last persisted, so when nothing is
  //    pending, adopting it is purely additive (stale → fresh, no loss).
  //  - Read-only on the server: this is a GET; it never writes. The
  //    comparator returns `prev` unchanged when the blob is identical, so
  //    no needless re-render and, crucially, no persist is triggered.
  //  - Throttled to once per 15s so rapid tab-switching doesn't spam.
  const lastStocksRefetchRef = useRef(0);
  useEffect(() => {
    if (loading) return;
    const maybeRefetchStocks = () => {
      if (document.visibilityState === "hidden") return;
      if (isStocksPersistPending()) return; // never clobber unsaved local edits
      const now = Date.now();
      if (now - lastStocksRefetchRef.current < 15_000) return;
      lastStocksRefetchRef.current = now;
      fetch("/api/kv/stocks")
        .then((r) => r.json())
        .then((res) => {
          if (isStocksPersistPending()) return; // re-check after the await
          const fetched: Stock[] = res?.stocks || [];
          if (fetched.length === 0) return; // never blank out on a bad read
          const { migrated } = migrateStockScores(fetched);
          setStocks((prev) =>
            JSON.stringify(prev) === JSON.stringify(migrated) ? prev : migrated,
          );
        })
        .catch(() => {}); // a failed refetch just leaves current state intact
    };
    window.addEventListener("focus", maybeRefetchStocks);
    document.addEventListener("visibilitychange", maybeRefetchStocks);
    return () => {
      window.removeEventListener("focus", maybeRefetchStocks);
      document.removeEventListener("visibilitychange", maybeRefetchStocks);
    };
  }, [loading, isStocksPersistPending]);

  const updateSector = useCallback((ticker: string, sector: string) => {
    setStocks((prev) => {
      const next = prev.map((s) => (s.ticker === ticker ? { ...s, sector } : s));
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updateHealthData = useCallback((ticker: string, healthData: HealthData) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, healthData } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updateTechnicals = useCallback((ticker: string, technicals: TechnicalIndicators, riskAlert: RiskAlert) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, technicals, riskAlert } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updateWeight = useCallback((ticker: string, weight: number) => {
    let stockRecord: Stock | undefined;
    setStocks((prev) => {
      const next = prev.map((s) => {
        if (s.ticker === ticker) {
          stockRecord = s;
          return { ...s, weights: { ...s.weights, portfolio: weight } };
        }
        return s;
      });
      persistStocks(next);
      return next;
    });

    // For ETFs/MFs: sync weightInClass across eligible PIM model groups
    // Only update groups that don't have an explicit per-model weight override
    setTimeout(() => {
      const stock = stockRecord || stocks.find((s) => s.ticker === ticker);
      if (!stock || isStock(stock)) return;

      const assetClass = detectAssetClass(stock);
      const eligibility = stock.modelEligibility || {};
      const modelWeights = stock.modelWeights || {};

      setPimModelsState((prev) => {
        const updatedGroups = prev.groups.map((group) => {
          if (eligibility[group.id] === false) return group;

          const holdingIdx = group.holdings.findIndex((h) => tickerMatch(h.symbol, ticker));
          if (holdingIdx === -1) return group;

          // Use per-model weight if set, otherwise use the new default weight
          const effectiveWeight = modelWeights[group.id] ?? weight;
          const balancedAlloc = getBalancedAlloc(group, assetClass);
          const newWeightInClass = balancedAlloc > 0
            ? parseFloat(((effectiveWeight / 100) / balancedAlloc).toFixed(6))
            : 0;

          const updatedHoldings = group.holdings.map((h, i) =>
            i === holdingIdx ? { ...h, weightInClass: newWeightInClass } : h
          );

          return { ...group, holdings: rebalanceStockWeights(updatedHoldings, undefined, group.id) };
        });

        const updated = { ...prev, groups: updatedGroups, lastUpdated: new Date().toISOString() };
        persistPim(updated);
        return updated;
      });
    }, 0);
  }, [persistStocks, stocks, isStock, detectAssetClass, tickerMatch, getBalancedAlloc, rebalanceStockWeights, persistPim]);

  /* ─── Per-model weight for ETFs/MFs ─── */
  const updateModelWeight = useCallback((ticker: string, groupId: string, weight: number) => {
    // 1. Persist modelWeights on the stock
    setStocks((prev) => {
      const next = prev.map((s) => {
        if (s.ticker !== ticker) return s;
        const modelWeights = { ...s.modelWeights, [groupId]: weight };
        return { ...s, modelWeights };
      });
      persistStocks(next);
      return next;
    });

    // 2. Update weightInClass in the specific PIM model group
    setTimeout(() => {
      const stock = stocks.find((s) => s.ticker === ticker);
      if (!stock || isStock(stock)) return;

      const assetClass = detectAssetClass(stock);

      setPimModelsState((prev) => {
        const updatedGroups = prev.groups.map((group) => {
          if (group.id !== groupId) return group;

          const holdingIdx = group.holdings.findIndex((h) => tickerMatch(h.symbol, ticker));
          if (holdingIdx === -1) return group;

          const balancedAlloc = getBalancedAlloc(group, assetClass);
          const newWeightInClass = balancedAlloc > 0
            ? parseFloat(((weight / 100) / balancedAlloc).toFixed(6))
            : 0;

          const updatedHoldings = group.holdings.map((h, i) =>
            i === holdingIdx ? { ...h, weightInClass: newWeightInClass } : h
          );

          return { ...group, holdings: rebalanceStockWeights(updatedHoldings, undefined, groupId) };
        });

        const updated = { ...prev, groups: updatedGroups, lastUpdated: new Date().toISOString() };
        persistPim(updated);
        return updated;
      });
    }, 0);
  }, [persistStocks, stocks, isStock, detectAssetClass, tickerMatch, getBalancedAlloc, rebalanceStockWeights, persistPim]);

  const updateFundData = useCallback((ticker: string, fundData: FundData) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, fundData } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const updateStockFields = useCallback((ticker: string, fields: Partial<Stock>) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, ...fields } : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  /* ─── Market data ─── */
  // Only persist the partial updates — NOT the full merged object.
  // The KV endpoint merges server-side: { ...existing, ...updates }.
  // Sending the full object would overwrite saved manual data with defaults
  // if called before KV data loads (e.g. live VIX fetch on mount).
  const updateMarketData = useCallback((updates: Partial<MarketData>) => {
    setMarketData((prev) => ({ ...prev, ...updates }));
    persistMarket(updates);
  }, [persistMarket]);

  /* ─── Brief ─── */
  const setBrief = useCallback((b: MorningBrief) => {
    setBriefState(b);
    persistBrief(b);
  }, [persistBrief]);

  /* ─── Chart Analysis ─── */
  const setChartAnalysis = useCallback((ticker: string, entry: ChartAnalysisEntry) => {
    setChartAnalysesState((prev) => {
      const next = { ...prev, [ticker]: entry };
      persistChartAnalyses(next);
      return next;
    });
  }, [persistChartAnalyses]);

  // Remove the saved analysis for a single ticker. Persists the deletion
  // to pm:chart-analysis via the same debounced PUT path so the entry
  // is gone across devices and refreshes.
  const clearChartAnalysis = useCallback((ticker: string) => {
    setChartAnalysesState((prev) => {
      if (!(ticker in prev)) return prev;
      const next = { ...prev };
      delete next[ticker];
      persistChartAnalyses(next);
      return next;
    });
  }, [persistChartAnalyses]);

  /* ─── Scanner Data ─── */
  const setScannerData = useCallback((data: ScannerData) => {
    setScannerDataState(data);
    persistScanner(data);
  }, [persistScanner]);

  /* ─── PIM Models ─── */
  const updatePimModels = useCallback((data: PimModelData) => {
    setPimModelsState(data);
    persistPim(data);
  }, [persistPim]);

  /* ─── PIM Portfolio State ─── */
  const updatePimPortfolioState = useCallback((data: PimPortfolioState) => {
    setPimPortfolioState(data);
    persistPortfolioState(data);
  }, [persistPortfolioState]);

  const getGroupState = useCallback((groupId: string): PimModelGroupState => {
    const existing = pimPortfolioState.groupStates.find((gs) => gs.groupId === groupId);
    return existing || { groupId, lastRebalance: null, trackingStart: null, transactions: [] };
  }, [pimPortfolioState]);

  /* ─── UI Preferences (synced to KV) ─── */
  const setUiPref = useCallback((key: string, value: string) => {
    setUiPrefsState((prev) => {
      const next = { ...prev, [key]: value };
      persistUiPrefs(next);
      return next;
    });
  }, [persistUiPrefs]);

  /* ─── Analyst snapshots (RBC / JPM / FactSet manual entry) ─── */
  const getAnalystSnapshot = useCallback((ticker: string) => {
    return getSnapshotForTicker(analystSnapshots, ticker);
  }, [analystSnapshots]);

  const updateAnalystSnapshot = useCallback((ticker: string, next: TickerSnapshot | undefined) => {
    setAnalystSnapshotsState((prev) => {
      const updated = setSnapshotForTicker(prev, ticker, next);
      persistAnalystSnapshots(updated);
      return updated;
    });
  }, [persistAnalystSnapshots]);

  const getAnalystReports = useCallback((ticker: string) => {
    return getReportsForTicker(analystReports, ticker);
  }, [analystReports]);

  const uploadAnalystReport = useCallback(async (
    ticker: string,
    source: "rbc" | "jpm",
    dataUrl: string,
    label: string
  ): Promise<{ ok: true; extracted: ExtractedReport } | { ok: false; error: string }> => {
    if (!dataUrl.startsWith("data:application/pdf;base64,")) {
      return { ok: false, error: "Expected a base64-encoded PDF" };
    }
    const reportId = reportIdFor(ticker, source);

    // 1) Extract (hash-gated cache → free if same PDF as last time).
    //    `extractedAt` is the ORIGINAL extraction timestamp from
    //    pm:analyst-report-extract-cache. On cache hits, this is when the
    //    PDF was first extracted (not the retry date) — which is what gets
    //    surfaced in the "All Ingested Reports" view on the Inbox page.
    let extractRes: { result: ExtractedReport; hash: string; extractedAt: string } | null = null;
    try {
      const res = await fetch("/api/analyst-report-extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker, source, dataUrl }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return { ok: false, error: err.error || `Extraction failed (${res.status})` };
      }
      const data = await res.json();
      extractRes = {
        result: data.result ?? {},
        hash: data.hash,
        extractedAt: typeof data.extractedAt === "string" ? data.extractedAt : new Date().toISOString(),
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Extraction request failed" };
    }

    // 2) Archive the PDF to Vercel Blob (no longer Redis — multi-MB PDFs are
    //    what kept OOMing the tier). The route returns the Blob URL.
    let pdfUrl: string | undefined;
    try {
      const res = await fetch(`/api/kv/analyst-reports/${encodeURIComponent(reportId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) {
        return { ok: false, error: `Failed to store PDF (${res.status})` };
      }
      const j = await res.json().catch(() => ({}));
      if (typeof j?.pdfUrl === "string") pdfUrl = j.pdfUrl;
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "PDF storage failed" };
    }

    // 3) Update the manifest with the new ReportMeta.
    const meta = {
      id: reportId,
      label,
      uploadedAt: new Date().toISOString(),
      extractedAt: extractRes.extractedAt,
      hash: extractRes.hash,
      extracted: extractRes.result,
      pdfUrl,
    };
    setAnalystReportsState((prev) => {
      const current = getReportsForTicker(prev, ticker) ?? {};
      const nextForTicker: TickerReports = { ...current, [source]: meta };
      const updated = setReportsForTicker(prev, ticker, nextForTicker);
      persistAnalystReports(updated);
      return updated;
    });

    // 4) Replace the snapshot entry with the new extraction. RBC/JPM fields
    //    are strictly PDF-driven now — no carryover from a previous PDF, no
    //    manual entry path. priceAtReport snapshots the current Yahoo price
    //    at upload time.
    const stockMatch = stocks.find((s) => s.ticker === ticker || s.ticker.toUpperCase() === ticker.toUpperCase());
    const priceAtUpload = stockMatch?.price;

    // 4a) Currency conversion: if the PDF target is in a different currency
    //     than the stock's trading currency, convert it using live USDCAD.
    const stockCcy = tickerCurrency(ticker);
    const pdfCcy = extractRes!.result.targetCurrency?.toUpperCase();
    let convertedTarget = extractRes!.result.target;
    let targetOriginal: number | undefined;
    let targetCurrencyField: string | undefined;
    let fxRateField: number | undefined;

    if (convertedTarget != null && pdfCcy && pdfCcy !== stockCcy) {
      try {
        // Use the report-date FX rate (not today's) — the analyst set their
        // target relative to FX conditions on the publication date.
        const reportDate = extractRes!.result.asOf; // YYYY-MM-DD or undefined
        const fxPair = `${pdfCcy}${stockCcy}`;
        const dateParam = reportDate ? `&date=${reportDate}` : "";
        const fxRes = await fetch(`/api/fx-rate?pair=${fxPair}${dateParam}`);
        const fxData = await fxRes.json();
        const rate = fxData.rate;
        if (typeof rate === "number" && rate > 0) {
          targetOriginal = convertedTarget;
          targetCurrencyField = pdfCcy;
          fxRateField = rate;
          convertedTarget = Math.round(convertedTarget * rate * 100) / 100;
          console.log(`[FX] ${ticker}: converted ${pdfCcy} $${targetOriginal} → ${stockCcy} $${convertedTarget} (${fxPair}=${rate}, date=${fxData.date})`);
        }
      } catch (e) {
        console.error(`Failed to fetch FX rate for ${pdfCcy}→${stockCcy}:`, e);
        // Fallback: use unconverted target (better than nothing)
      }
    }

    let derivedSnapshot: TickerSnapshot | undefined;
    setAnalystSnapshotsState((prev) => {
      const currentSnapshot = getSnapshotForTicker(prev, ticker) ?? {};
      const merged: AnalystEntry = {
        rating: extractRes!.result.rating ?? "not-covered",
        target: convertedTarget,
        ...(targetOriginal != null ? { targetOriginal, targetCurrency: targetCurrencyField, fxRate: fxRateField } : {}),
        asOf: extractRes!.result.asOf,
        priceAtReport: priceAtUpload,
        reportId,
        lastUpdated: new Date().toISOString(),
      };
      const nextSnapshot: TickerSnapshot = { ...currentSnapshot, [source]: merged };
      derivedSnapshot = nextSnapshot;
      const updated = setSnapshotForTicker(prev, ticker, nextSnapshot);
      persistAnalystSnapshots(updated);
      return updated;
    });

    // Auto-derive analystConsensus score + explanation from the updated
    // snapshot so the RBC/JPM rating + FactSet upside components are
    // immediately reflected without waiting for a full Claude rescore.
    if (derivedSnapshot) {
      const consensus = computeAnalystConsensus(derivedSnapshot, priceAtUpload);
      updateScore(ticker, "analystConsensus", consensus.score);
      updateExplanations(ticker, { analystConsensus: buildConsensusExplanation(consensus) });
    }

    return { ok: true, extracted: extractRes.result };
  }, [persistAnalystReports, persistAnalystSnapshots, stocks, updateScore, updateExplanations, tickerCurrency]);

  const removeAnalystReport = useCallback(async (ticker: string, source: "rbc" | "jpm") => {
    const reportId = reportIdFor(ticker, source);
    try {
      await fetch(`/api/kv/analyst-reports/${encodeURIComponent(reportId)}`, { method: "DELETE" });
    } catch (e) {
      console.error("Failed to delete PDF blob:", e);
    }
    setAnalystReportsState((prev) => {
      const current = getReportsForTicker(prev, ticker);
      if (!current || !current[source]) return prev;
      const nextForTicker: TickerReports = { ...current };
      delete nextForTicker[source];
      const updated = setReportsForTicker(prev, ticker, Object.keys(nextForTicker).length ? nextForTicker : undefined);
      persistAnalystReports(updated);
      return updated;
    });
    // RBC/JPM fields are PDF-driven only — removing the PDF removes the entry
    // entirely so no orphan rating/target lingers in the composite.
    let derivedSnapshot: TickerSnapshot | undefined;
    setAnalystSnapshotsState((prev) => {
      const currentSnapshot = getSnapshotForTicker(prev, ticker);
      if (!currentSnapshot || !currentSnapshot[source]) return prev;
      const nextSnapshot: TickerSnapshot = { ...currentSnapshot };
      delete nextSnapshot[source];
      derivedSnapshot = nextSnapshot;
      const updated = setSnapshotForTicker(prev, ticker, nextSnapshot);
      persistAnalystSnapshots(updated);
      return updated;
    });

    // Re-derive analystConsensus score + explanation with the removed entry gone.
    const stockPrice = stocks.find((s) => s.ticker === ticker || s.ticker.toUpperCase() === ticker.toUpperCase())?.price;
    const hasAny = derivedSnapshot && (derivedSnapshot.rbc || derivedSnapshot.jpm || derivedSnapshot.factset);
    const consensus = computeAnalystConsensus(hasAny ? derivedSnapshot : undefined, stockPrice);
    updateScore(ticker, "analystConsensus", consensus.score);
    updateExplanations(ticker, { analystConsensus: buildConsensusExplanation(consensus) });
  }, [persistAnalystReports, persistAnalystSnapshots, stocks, updateScore, updateExplanations]);

  // Convert an existing analyst target's currency without re-extraction.
  // This is for pre-existing data where `targetCurrency` wasn't captured.
  const convertAnalystTarget = useCallback(async (ticker: string, source: "rbc" | "jpm", fromCurrency: string) => {
    const stockCcy = tickerCurrency(ticker);
    if (fromCurrency === stockCcy) return; // no conversion needed

    const snap = getSnapshotForTicker(analystSnapshots, ticker);
    const entry = snap?.[source];
    if (!entry?.target) return;

    // Use the report-date FX rate when available (analyst set their target
    // relative to FX conditions at publication). Falls back to live rate.
    const fxPair = `${fromCurrency}${stockCcy}`;
    const dateParam = entry.asOf ? `&date=${entry.asOf}` : "";
    try {
      const fxRes = await fetch(`/api/fx-rate?pair=${fxPair}${dateParam}`);
      const fxData = await fxRes.json();
      const rate = fxData.rate;
      if (typeof rate !== "number" || rate <= 0) {
        console.error(`[FX] No rate for ${fxPair} on ${entry.asOf ?? "live"}`);
        return;
      }

      const originalTarget = entry.target;
      const convertedTarget = Math.round(originalTarget * rate * 100) / 100;
      console.log(`[FX] ${ticker}/${source}: converting ${fromCurrency} $${originalTarget} → ${stockCcy} $${convertedTarget} (${fxPair}=${rate}, date=${fxData.date})`);

      let derivedSnapshot: TickerSnapshot | undefined;
      setAnalystSnapshotsState((prev) => {
        const currentSnapshot = getSnapshotForTicker(prev, ticker) ?? {};
        const currentEntry = currentSnapshot[source];
        if (!currentEntry?.target) return prev;
        const updatedEntry: AnalystEntry = {
          ...currentEntry,
          target: convertedTarget,
          targetOriginal: originalTarget,
          targetCurrency: fromCurrency,
          fxRate: rate,
          lastUpdated: new Date().toISOString(),
        };
        const nextSnapshot: TickerSnapshot = { ...currentSnapshot, [source]: updatedEntry };
        derivedSnapshot = nextSnapshot;
        const updated = setSnapshotForTicker(prev, ticker, nextSnapshot);
        persistAnalystSnapshots(updated);
        return updated;
      });

      // Re-derive analystConsensus score + explanation
      if (derivedSnapshot) {
        const stockPrice = stocks.find((s) => s.ticker === ticker || s.ticker.toUpperCase() === ticker.toUpperCase())?.price;
        const consensus = computeAnalystConsensus(derivedSnapshot, stockPrice);
        updateScore(ticker, "analystConsensus", consensus.score);
        updateExplanations(ticker, { analystConsensus: buildConsensusExplanation(consensus) });
      }
    } catch (e) {
      console.error(`Failed to convert ${source} target for ${ticker}:`, e);
    }
  }, [analystSnapshots, persistAnalystSnapshots, stocks, updateScore, updateExplanations, tickerCurrency]);

  /* ─── Toggle model eligibility: updates stock field AND syncs model holdings ─── */
  const toggleModelEligibility = useCallback((ticker: string, groupId: string, eligible: boolean) => {
    // 1. Update the stock's modelEligibility field
    const stock = stocks.find((s) => s.ticker === ticker);
    if (!stock) return;

    const current = stock.modelEligibility || {};
    const updated = { ...current, [groupId]: eligible };
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, modelEligibility: updated } : s
      );
      persistStocks(next);
      return next;
    });

    // 2. Sync PIM models: add or remove from the specific group
    if (eligible) {
      // Add to this specific model group
      const assetClass = detectAssetClass(stock);
      // PIM models only support CAD/USD — cast the general currency string
      const currency = tickerCurrency(stock.ticker) as "CAD" | "USD";

      setPimModelsState((prev) => {
        const updatedGroups = prev.groups.map((group) => {
          if (group.id !== groupId) return group;
          if (group.holdings.some((h) => tickerMatch(h.symbol, stock.ticker))) return group;

          // For ETFs/MFs: derive weightInClass from per-model weight or fallback
          let initialWeightInClass = 0;
          if (!isStock(stock)) {
            const manualWeight = stock.modelWeights?.[group.id] ?? stock.weights.portfolio;
            if (manualWeight > 0) {
              const balancedAlloc = getBalancedAlloc(group, assetClass);
              if (balancedAlloc > 0) {
                initialWeightInClass = parseFloat(((manualWeight / 100) / balancedAlloc).toFixed(6));
              }
            }
          }

          const newHoldings = [...group.holdings, {
            name: (stock.name || stock.ticker).toUpperCase(),
            symbol: stock.ticker,
            currency,
            assetClass,
            weightInClass: initialWeightInClass,
          }];

          // Rebalance individual stocks (works for both stock and ETF/MF additions)
          if (isStock(stock)) {
            return { ...group, holdings: rebalanceStockWeights(newHoldings, stock, group.id) };
          } else {
            return { ...group, holdings: rebalanceStockWeights(newHoldings, undefined, group.id) };
          }
        });
        const data = { ...prev, groups: updatedGroups, lastUpdated: new Date().toISOString() };
        persistPim(data);
        return data;
      });
    } else {
      // Remove from this specific model group
      setPimModelsState((prev) => {
        const updatedGroups = prev.groups.map((group) => {
          if (group.id !== groupId) return group;
          const holdingIdx = group.holdings.findIndex((h) => tickerMatch(h.symbol, ticker));
          if (holdingIdx === -1) return group;

          const remaining = group.holdings.filter((_, i) => i !== holdingIdx);
          // Rebalance individual stocks to redistribute freed weight
          return { ...group, holdings: rebalanceStockWeights(remaining, undefined, group.id) };
        });
        const data = { ...prev, groups: updatedGroups, lastUpdated: new Date().toISOString() };
        persistPim(data);
        return data;
      });
    }
  }, [stocks, persistStocks, persistPim, detectAssetClass, isStock, tickerMatch, tickerCurrency, rebalanceStockWeights, getBalancedAlloc]);

  const getStock = useCallback(
    (ticker: string) => scoredStocks.find((s) => tickerMatch(s.ticker, ticker)),
    [scoredStocks, tickerMatch]
  );

  return (
    <StockContext.Provider
      value={{
        stocks,
        scoredStocks,
        marketData,
        brief,
        chartAnalyses,
        scannerData,
        offensiveExposure,
        loading,
        addStock,
        removeStock,
        moveBucket,
        updateScore,
        updateExplanations,
        updateLastScored,
        updatePrice,
        refreshAllPrices,
        priceRefreshNonce,
        livePreviousCloses,
        refreshResearchMentions,
        updateSector,
        updateWeight,
        updateFundData,
        updateHealthData,
        updateTechnicals,
        updateStockFields,
        setBrief,
        setChartAnalysis,
        clearChartAnalysis,
        setScannerData,
        updateMarketData,
        getStock,
        portfolioStocks,
        watchlistStocks,
        pimModels,
        updatePimModels,
        rebalanceStockWeights,
        toggleModelEligibility,
        updateModelWeight,
        pimPortfolioState,
        updatePimPortfolioState,
        getGroupState,
        uiPrefs,
        setUiPref,
        analystSnapshots,
        getAnalystSnapshot,
        updateAnalystSnapshot,
        analystReports,
        getAnalystReports,
        uploadAnalystReport,
        removeAnalystReport,
        convertAnalystTarget,
        tickerCurrency,
        flushStocks,
      }}
    >
      {children}
    </StockContext.Provider>
  );
}
