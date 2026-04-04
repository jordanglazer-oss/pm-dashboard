"use client";

import React, { createContext, useContext, useState, useMemo, useCallback, useEffect, useRef } from "react";
import type { Stock, MarketData, ScoredStock, MorningBrief, ScoreKey, ScoreExplanations, HealthData, TechnicalIndicators, RiskAlert } from "./types";
import { computeScores, isOffensiveSector } from "./scoring";
import { holdingsSeed, defaultMarketData } from "./defaults";

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
  updateStockFields: (ticker: string, fields: Partial<Stock>) => void;
  setBrief: (brief: MorningBrief) => void;
  setChartAnalysis: (ticker: string, entry: ChartAnalysisEntry) => void;
  setScannerData: (data: ScannerData) => void;
  updateMarketData: (updates: Partial<MarketData>) => void;
  getStock: (ticker: string) => ScoredStock | undefined;
  portfolioStocks: ScoredStock[];
  watchlistStocks: ScoredStock[];
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

  /* ─── Load from KV on mount ─── */
  useEffect(() => {
    Promise.all([
      fetch("/api/kv/stocks").then((r) => r.json()).catch(() => ({ stocks: holdingsSeed })),
      fetch("/api/kv/market").then((r) => r.json()).catch(() => ({ market: defaultMarketData })),
      fetch("/api/kv/brief").then((r) => r.json()).catch(() => ({ brief: null })),
      fetch("/api/kv/chart-analysis").then((r) => r.json()).catch(() => ({ chartAnalyses: {} })),
      fetch("/api/kv/scanner").then((r) => r.json()).catch(() => ({ scanner: null })),
    ]).then(async ([stocksRes, marketRes, briefRes, chartRes, scannerRes]) => {
      const loadedStocks: Stock[] = stocksRes.stocks || holdingsSeed;
      setStocks(loadedStocks);
      if (marketRes.market) setMarketData({ ...defaultMarketData, ...marketRes.market });
      if (briefRes.brief) setBriefState(briefRes.brief);
      if (chartRes.chartAnalyses) setChartAnalysesState(chartRes.chartAnalyses);
      if (scannerRes.scanner) setScannerDataState(scannerRes.scanner);
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
                const shouldUpdateSector = newSector && newSector !== s.sector;
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
        .filter((s) => s.bucket === "Portfolio" && isOffensiveSector(s.sector))
        .reduce((sum, s) => sum + s.weights.portfolio, 0),
    [scoredStocks]
  );

  /* ─── Stock mutations (optimistic + persist) ─── */
  const addStock = useCallback((stock: Stock) => {
    setStocks((prev) => {
      const next = [stock, ...prev];
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const removeStock = useCallback((ticker: string) => {
    setStocks((prev) => {
      const next = prev.filter((s) => s.ticker !== ticker);
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

  const moveBucket = useCallback((ticker: string) => {
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker
          ? { ...s, bucket: (s.bucket === "Portfolio" ? "Watchlist" : "Portfolio") as "Portfolio" | "Watchlist", weights: { portfolio: s.bucket === "Portfolio" ? 0 : 2 } }
          : s
      );
      persistStocks(next);
      return next;
    });
  }, [persistStocks]);

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
    setStocks((prev) => {
      const next = prev.map((s) =>
        s.ticker === ticker ? { ...s, weights: { ...s.weights, portfolio: weight } } : s
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
      }}
    >
      {children}
    </StockContext.Provider>
  );
}
