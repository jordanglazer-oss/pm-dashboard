"use client";

import React, { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { Stock, MarketData, ScoredStock, MorningBrief, ScoreKey, ScoreExplanations, HealthData, TechnicalIndicators, RiskAlert, FundData } from "./types";
import type { PimHolding, PimModelData, PimPortfolioState, PimModelGroupState } from "./pim-types";
import { computeScores, isOffensiveSector, isScoreable } from "./scoring";
import { holdingsSeed, defaultMarketData } from "./defaults";
import { pimModelSeed } from "./pim-seed";

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
  const [stocks, setStocks] = useState<Stock[]>(holdingsSeed);
  const [marketData, setMarketData] = useState<MarketData>(defaultMarketData);
  const [brief, setBriefState] = useState<MorningBrief | null>(null);
  const [chartAnalyses, setChartAnalysesState] = useState<Record<string, ChartAnalysisEntry>>({});
  const [scannerData, setScannerDataState] = useState<ScannerData | null>(null);
  const [pimModels, setPimModelsState] = useState<PimModelData>({ groups: pimModelSeed });
  const [pimPortfolioState, setPimPortfolioState] = useState<PimPortfolioState>({ groupStates: [], lastUpdated: "" });
  const [uiPrefs, setUiPrefsState] = useState<Record<string, string>>({});
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

  /* ─── Load from KV on mount ─── */
  useEffect(() => {
    Promise.all([
      fetch("/api/kv/stocks").then((r) => r.json()).catch(() => ({ stocks: holdingsSeed })),
      fetch("/api/kv/market").then((r) => r.json()).catch(() => ({ market: defaultMarketData })),
      fetch("/api/kv/brief").then((r) => r.json()).catch(() => ({ brief: null })),
      fetch("/api/kv/chart-analysis").then((r) => r.json()).catch(() => ({ chartAnalyses: {} })),
      fetch("/api/kv/scanner").then((r) => r.json()).catch(() => ({ scanner: null })),
      fetch("/api/kv/pim-models").then((r) => r.json()).catch(() => ({ groups: pimModelSeed })),
      fetch("/api/kv/pim-portfolio-state").then((r) => r.json()).catch(() => ({ groupStates: [], lastUpdated: "" })),
      fetch("/api/kv/ui-prefs").then((r) => r.json()).catch(() => ({ uiPrefs: {} })),
    ]).then(async ([stocksRes, marketRes, briefRes, chartRes, scannerRes, pimRes, portfolioStateRes, uiPrefsRes]) => {
      const loadedStocks: Stock[] = stocksRes.stocks || holdingsSeed;
      setStocks(loadedStocks);
      if (marketRes.market) setMarketData({ ...defaultMarketData, ...marketRes.market });
      if (briefRes.brief) setBriefState(briefRes.brief);
      if (chartRes.chartAnalyses) setChartAnalysesState(chartRes.chartAnalyses);
      if (scannerRes.scanner) setScannerDataState(scannerRes.scanner);
      if (pimRes.groups) setPimModelsState(pimRes);
      if (portfolioStateRes.groupStates) setPimPortfolioState(portfolioStateRes);
      if (uiPrefsRes.uiPrefs) setUiPrefsState(uiPrefsRes.uiPrefs);
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
                    }
                    if (existing?.holdingsUrl && !merged.holdingsUrl) {
                      merged.holdingsUrl = existing.holdingsUrl;
                    }
                    if (existing?.holdingsLastUpdated && !merged.holdingsLastUpdated) {
                      merged.holdingsLastUpdated = existing.holdingsLastUpdated;
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

  const scoredStocks = useMemo(
    () => stocks.map((s) => computeScores(s, marketData)),
    [stocks, marketData]
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
  const tickerCurrency = useCallback((ticker: string): "CAD" | "USD" => {
    if (ticker.endsWith(".U")) return "USD";
    if (ticker.endsWith("-T") || ticker.endsWith(".TO")) return "CAD";
    return "USD";
  }, []);

  /* ─── Rebalance: set all individual stocks to equal weight within equity class ─── */
  const rebalanceStockWeights = useCallback((holdings: PimHolding[], extraStock?: Stock): PimHolding[] => {
    // Count individual stocks (equity class, not ETF/MF pattern)
    // We identify ETFs/MFs by their symbol patterns or by checking if they existed
    // in the original seed (they have non-equal weights). Simpler: use the stocks list.
    const currentStocks = stocks.filter((s) => s.bucket === "Portfolio" && isStock(s));
    // Include the newly-added stock that may not be in state yet
    if (extraStock && isStock(extraStock) && !currentStocks.some((s) => s.ticker === extraStock.ticker)) {
      currentStocks.push(extraStock);
    }
    const stockTickers = new Set(currentStocks.map((s) => s.ticker));
    // Also add .TO variants
    currentStocks.forEach((s) => {
      stockTickers.add(s.ticker.replace(".TO", "-T"));
      stockTickers.add(s.ticker.replace("-T", ".TO"));
    });

    const equityHoldings = holdings.filter((h) => h.assetClass === "equity");
    const stockHoldings = equityHoldings.filter((h) => stockTickers.has(h.symbol));
    const etfHoldings = equityHoldings.filter((h) => !stockTickers.has(h.symbol));
    const nonEquity = holdings.filter((h) => h.assetClass !== "equity");

    if (stockHoldings.length === 0) return holdings;

    // Individual stocks get equal weight. ETFs keep their existing weights.
    // Total equity weight = 1.0 (100% of equity class).
    // ETFs take their portion, stocks share the remainder equally.
    const etfTotal = etfHoldings.reduce((s, h) => s + h.weightInClass, 0);
    const stockTotal = 1.0 - etfTotal;
    const perStock = stockTotal > 0 ? stockTotal / stockHoldings.length : 0;

    const rebalanced = [
      ...nonEquity,
      ...etfHoldings,
      ...stockHoldings.map((h) => ({ ...h, weightInClass: parseFloat(perStock.toFixed(6)) })),
    ];

    return rebalanced;
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
    // Auto-add to eligible PIM models
    addToPimModels(stock);
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
      addToPimModels(stock);
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
    (ticker: string) => scoredStocks.find((s) => s.ticker === ticker),
    [scoredStocks]
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
      }}
    >
      {children}
    </StockContext.Provider>
  );
}
