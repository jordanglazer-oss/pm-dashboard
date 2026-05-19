"use client";

import React, { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { Stock, MarketData, ScoredStock, MorningBrief, ScoreKey, ScoreExplanations, HealthData, TechnicalIndicators, RiskAlert, FundData } from "./types";
import type { PimHolding, PimModelData, PimPortfolioState, PimModelGroupState } from "./pim-types";
import { computeScores, isOffensiveSector, isScoreable } from "./scoring";
import { defaultMarketData } from "./defaults";
import { pimModelSeed } from "./pim-seed";
import type { AnalystSnapshots, TickerSnapshot, AnalystReports, TickerReports, AnalystEntry, ExtractedReport } from "./analyst-snapshots";
import { setSnapshotForTicker, getSnapshotForTicker, setReportsForTicker, getReportsForTicker, reportIdFor, computeAnalystConsensus, buildConsensusExplanation } from "./analyst-snapshots";
import { mapBoostedAiToAiRating, mapSmaxToRelativeStrength, type BoostedAiConsensus } from "./external-scoring";

// Locked equity holdings: specialty funds whose weightInClass is driven by
// the per-model Balanced weight (%) input on the stock page — NOT by the
// residual-redistribution math in rebalanceStockWeights. Without locking,
// adding or removing any individual stock shifts their weight by a few bps
// (the rebalancer scales the entire non-stock pool proportionally), which
// propagates through to the PIM Model / Positioning tabs and the
// automated performance numbers. Core index ETFs (XSP, XUS, XUH, XUU, XSU)
// stay unlocked — they are the intended absorbers of residual equity
// weight when stocks come and go.
// Both "FID5982" and "FID5982-T" listed because the persisted pm:pim-models
// uses the bare "FID5982" (no -T suffix) even though pim-seed.ts stores it
// as "FID5982-T". Listing both forms keeps the lock effective regardless of
// which variant shows up after future migrations or re-adds.
const LOCKED_EQUITY_SYMBOLS = new Set(["FID5982", "FID5982-T", "GRNJ"]);

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
    const es = scores.externalSources ?? 0;
    const ac = scores.analystConsensus;
    const rm = scores.researchMentions;
    const needsRcClamp = rc > 1;
    const needsEsClamp = es > 1;
    const needsAcDefault = ac === undefined || ac === null;
    const needsRmDefault = rm === undefined || rm === null;
    if (!needsRcClamp && !needsEsClamp && !needsAcDefault && !needsRmDefault) return s;
    changed = true;
    return {
      ...s,
      scores: {
        ...scores,
        researchCoverage: Math.min(rc, 1),
        externalSources: Math.min(es, 1),
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
};

const StockContext = createContext<StockContextType | null>(null);

export function useStocks() {
  const ctx = useContext(StockContext);
  if (!ctx) throw new Error("useStocks must be used within StockProvider");
  return ctx;
}

/* ─── Debounced persist helper ─── */
function useDebouncedPersist(url: string, bodyKey: string, delay = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (data: unknown) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fetch(url, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [bodyKey]: data }),
        }).catch((e) => console.error(`Failed to persist ${bodyKey}:`, e));
      }, delay);
    },
    [url, bodyKey, delay]
  );
}

export function StockProvider({ children }: { children: React.ReactNode }) {
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [marketData, setMarketData] = useState<MarketData>(defaultMarketData);
  const [brief, setBriefState] = useState<MorningBrief | null>(null);
  const [chartAnalyses, setChartAnalysesState] = useState<Record<string, ChartAnalysisEntry>>({});
  const [scannerData, setScannerDataState] = useState<ScannerData | null>(null);
  const [pimModels, setPimModelsState] = useState<PimModelData>({ groups: pimModelSeed });
  const [pimPortfolioState, setPimPortfolioState] = useState<PimPortfolioState>({ groupStates: [], lastUpdated: "" });
  const [uiPrefs, setUiPrefsState] = useState<Record<string, string>>({});
  const [analystSnapshots, setAnalystSnapshotsState] = useState<AnalystSnapshots>({});
  const [analystReports, setAnalystReportsState] = useState<AnalystReports>({});
  const [loading, setLoading] = useState(true);

  const persistStocks = useDebouncedPersist("/api/kv/stocks", "stocks");
  // Market data persists immediately (not debounced) since updates are explicit save actions
  const persistMarket = useCallback((data: unknown) => {
    fetch("/api/kv/market", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates: data }),
    }).catch((e) => console.error("Failed to persist market:", e));
  }, []);
  const persistBrief = useDebouncedPersist("/api/kv/brief", "brief", 100);
  const persistChartAnalyses = useDebouncedPersist("/api/kv/chart-analysis", "chartAnalyses", 300);
  const persistScanner = useDebouncedPersist("/api/kv/scanner", "scanner", 300);
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
  const persistUiPrefs = useDebouncedPersist("/api/kv/ui-prefs", "uiPrefs", 300);
  const persistAnalystSnapshots = useDebouncedPersist("/api/kv/analyst-snapshots", "snapshots", 400);
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
      fetch("/api/kv/pim-models").then((r) => r.json()).catch(() => ({ groups: pimModelSeed })),
      fetch("/api/kv/pim-portfolio-state").then((r) => r.json()).catch(() => ({ groupStates: [], lastUpdated: "" })),
      fetch("/api/kv/ui-prefs").then((r) => r.json()).catch(() => ({ uiPrefs: {} })),
      fetch("/api/kv/analyst-snapshots").then((r) => r.json()).catch(() => ({ snapshots: {} })),
      fetch("/api/kv/analyst-reports").then((r) => r.json()).catch(() => ({ reports: {} })),
    ]).then(async ([stocksRes, marketRes, briefRes, chartRes, scannerRes, pimRes, portfolioStateRes, uiPrefsRes, analystSnapshotsRes, analystReportsRes]) => {
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
                // Look up the correct currency from pim-seed
                let seedCurrency: "CAD" | "USD" = "CAD"; // default fallback
                for (const sg of pimModelSeed) {
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
  // .U suffix = USD-denominated Canadian-listed ETF (e.g., XUS.U, XUU.U)
  // FUNDSERV codes: check pim-seed for authoritative currency, default CAD
  const tickerCurrency = useCallback((ticker: string): "CAD" | "USD" => {
    if (ticker.endsWith(".U")) return "USD";
    if (ticker.endsWith("-T") || ticker.endsWith(".TO")) return "CAD";
    // FUNDSERV codes — look up in seed data for authoritative currency
    const base = ticker.replace(/-T$/, "");
    if (/^[A-Z]{2,4}\d{2,5}$/i.test(base)) {
      // Check seed for this symbol's currency
      for (const g of pimModelSeed) {
        const seedHolding = g.holdings.find((h) => h.symbol === ticker || h.symbol === base);
        if (seedHolding) return seedHolding.currency;
      }
      return "CAD"; // default for unknown FUNDSERV
    }
    return "USD";
  }, []);

  /* ─── Rebalance: individual stocks keep fixed weight, freed weight → Core ETFs ─── */
  const rebalanceStockWeights = useCallback((holdings: PimHolding[], extraStock?: Stock): PimHolding[] => {
    // Reference per-stock weight from PIM base model seed (constant across all models)
    const pimBaseGroup = pimModelSeed.find((g) => g.id === "pim");
    const refPerStock = 0.018182; // PIM seed default for individual stocks

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

    const equityHoldings = holdings.filter((h) => h.assetClass === "equity");
    const nonEquity = holdings.filter((h) => h.assetClass !== "equity");

    // Split equity holdings into three pools:
    //   1) individual stocks — locked at refPerStock
    //   2) locked specialty funds — pass-through, keep current weightInClass
    //   3) core ETFs — absorb residual equity weight proportionally
    const stockHoldings = equityHoldings.filter((h) => seedStockSymbols.has(h.symbol));
    const lockedHoldings = equityHoldings.filter(
      (h) => !seedStockSymbols.has(h.symbol) && LOCKED_EQUITY_SYMBOLS.has(h.symbol)
    );
    const etfHoldings = equityHoldings.filter(
      (h) => !seedStockSymbols.has(h.symbol) && !LOCKED_EQUITY_SYMBOLS.has(h.symbol)
    );

    if (stockHoldings.length === 0 && etfHoldings.length === 0 && lockedHoldings.length === 0) return holdings;

    // Each stock keeps the SAME per-stock weight as the PIM base model
    const stockTotal = refPerStock * stockHoldings.length;

    // Locked specialty funds keep their existing weightInClass untouched
    const lockedTotal = lockedHoldings.reduce((s, h) => s + h.weightInClass, 0);

    // Core (unlocked) ETFs absorb the remainder proportionally per PIM seed ratios
    const seedEtfWeights = new Map<string, number>();
    if (pimBaseGroup) {
      for (const h of pimBaseGroup.holdings) {
        if (
          h.assetClass === "equity" &&
          !seedStockSymbols.has(h.symbol) &&
          !LOCKED_EQUITY_SYMBOLS.has(h.symbol)
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
  }, [stocks, isStock]);

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
      const currency = tickerCurrency(stock.ticker);
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
          return { ...group, holdings: rebalanceStockWeights(newHoldings, stock) };
        } else {
          // Rebalance individual stocks in case ETF is in equity class
          return { ...group, holdings: rebalanceStockWeights(newHoldings) };
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
        return { ...group, holdings: rebalanceStockWeights(remainingHoldings) };
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

          return { ...group, holdings: rebalanceStockWeights(updatedHoldings) };
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

          return { ...group, holdings: rebalanceStockWeights(updatedHoldings) };
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

    // 2) Store the PDF dataUrl.
    try {
      const res = await fetch(`/api/kv/analyst-reports/${encodeURIComponent(reportId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dataUrl }),
      });
      if (!res.ok) {
        return { ok: false, error: `Failed to store PDF (${res.status})` };
      }
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
    //    at upload time so freshness decay can detect adverse moves later.
    const stockMatch = stocks.find((s) => s.ticker === ticker || s.ticker.toUpperCase() === ticker.toUpperCase());
    const priceAtUpload = stockMatch?.price;
    let derivedSnapshot: TickerSnapshot | undefined;
    setAnalystSnapshotsState((prev) => {
      const currentSnapshot = getSnapshotForTicker(prev, ticker) ?? {};
      const merged: AnalystEntry = {
        rating: extractRes!.result.rating ?? "not-covered",
        target: extractRes!.result.target,
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
  }, [persistAnalystReports, persistAnalystSnapshots, stocks, updateScore]);

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
      const currency = tickerCurrency(stock.ticker);

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
            return { ...group, holdings: rebalanceStockWeights(newHoldings, stock) };
          } else {
            return { ...group, holdings: rebalanceStockWeights(newHoldings) };
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
          return { ...group, holdings: rebalanceStockWeights(remaining) };
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
      }}
    >
      {children}
    </StockContext.Provider>
  );
}
