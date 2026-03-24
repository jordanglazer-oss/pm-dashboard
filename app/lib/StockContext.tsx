"use client";

import React, { createContext, useContext, useState, useMemo, useCallback } from "react";
import type { Stock, MarketData, ScoredStock, MorningBrief, ScoreKey, Scores } from "./types";
import { computeScores, isOffensiveSector } from "./scoring";

type StockContextType = {
  stocks: Stock[];
  scoredStocks: ScoredStock[];
  marketData: MarketData;
  brief: MorningBrief | null;
  offensiveExposure: number;
  addStock: (stock: Stock) => void;
  removeStock: (ticker: string) => void;
  moveBucket: (ticker: string) => void;
  updateScore: (ticker: string, key: ScoreKey, value: number) => void;
  updateSector: (ticker: string, sector: string) => void;
  setBrief: (brief: MorningBrief) => void;
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

const defaultMarketData: MarketData = {
  date: "March 23, 2026",
  compositeSignal: "Bearish",
  conviction: "High",
  riskRegime: "Risk-Off",
  hedgeScore: 78,
  hedgeTiming: "Favorable",
  breadth: 47.9,
  vix: 27.2,
  move: 91.2,
  fearGreed: 24,
  hyOas: 309,
  igOas: 96,
  aaiiBullBear: -18,
  putCall: 1.08,
  termStructure: "Contango",
};

const holdingsSeed: Stock[] = [
  {
    ticker: "META",
    name: "Meta Platforms, Inc.",
    bucket: "Portfolio",
    sector: "Communication Services",
    beta: 1.18,
    weights: { portfolio: 7.2 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 1, aiRating: 1, growth: 2, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 2, trackRecord: 1, ownershipTrends: 1 },
    notes: "Ad resilience still good, but cyclical growth multiple risk is rising in a weak-breadth market.",
  },
  {
    ticker: "CRM",
    name: "Salesforce, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.27,
    weights: { portfolio: 5.6 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 1, growth: 2, relativeValuation: 1, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 1 },
    notes: "Strong SaaS franchise, but regime fit is poor while spreads widen and growth leadership fades.",
  },
  {
    ticker: "BN",
    name: "Brookfield Corporation",
    bucket: "Portfolio",
    sector: "Financials",
    beta: 0.92,
    weights: { portfolio: 4.3 },
    scores: { brand: 2, secular: 1, researchCoverage: 4, externalSources: 0, charting: 2, relativeStrength: 2, aiRating: 2, growth: 2, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 1, catalysts: 2, trackRecord: 1, ownershipTrends: 1 },
    notes: "More resilient than pure growth and better aligned with real-asset and capital rotation themes.",
  },
  {
    ticker: "GOOGL",
    name: "Alphabet Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.06,
    weights: { portfolio: 6.0 },
    scores: { brand: 2, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 1, aiRating: 0, growth: 2, relativeValuation: 2, historicalValuation: 2, leverageCoverage: 2, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 2, trackRecord: 1, ownershipTrends: 0 },
    notes: "Search dominance intact, AI investment heavy but funded by cash generation. Regulatory overhang persists.",
  },
  {
    ticker: "AMZN",
    name: "Amazon.com, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.15,
    weights: { portfolio: 5.5 },
    scores: { brand: 2, secular: 2, researchCoverage: 4, externalSources: 0, charting: 0, relativeStrength: 0, aiRating: 0, growth: 2, relativeValuation: 1, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "AWS growth re-accelerating but retail margins under pressure. Expensive on most metrics.",
  },
  {
    ticker: "JPM",
    name: "JPMorgan Chase & Co.",
    bucket: "Portfolio",
    sector: "Financials",
    beta: 1.05,
    weights: { portfolio: 4.0 },
    scores: { brand: 1, secular: 1, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 1, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Best-in-class bank but credit cycle risk rising. NII tailwinds fading as rate curve shifts.",
  },
  {
    ticker: "UNH",
    name: "UnitedHealth Group Inc.",
    bucket: "Portfolio",
    sector: "Health Care",
    beta: 0.65,
    weights: { portfolio: 4.5 },
    scores: { brand: 1, secular: 1, researchCoverage: 3, externalSources: 0, charting: 0, relativeStrength: 0, aiRating: 0, growth: 1, relativeValuation: 1, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Defensive quality name under political pressure. Medical loss ratio trending higher.",
  },
  {
    ticker: "UBER",
    name: "Uber Technologies, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.35,
    weights: { portfolio: 3.5 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 2, relativeValuation: 2, historicalValuation: 2, leverageCoverage: 2, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 2, trackRecord: 1, ownershipTrends: 1 },
    notes: "Network effects strengthening, FCF inflecting positive. Autonomous vehicle risk is overstated near-term.",
  },
  {
    ticker: "PANW",
    name: "Palo Alto Networks, Inc.",
    bucket: "Portfolio",
    sector: "Technology",
    beta: 1.2,
    weights: { portfolio: 3.5 },
    scores: { brand: 0, secular: 2, researchCoverage: 4, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 2, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 2, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Platformization working but billings deceleration spooked the street. Valuation still full.",
  },
  {
    ticker: "XLE",
    name: "Energy Select Sector SPDR",
    bucket: "Watchlist",
    sector: "Energy",
    beta: 1.05,
    weights: { portfolio: 0 },
    scores: { brand: 1, secular: 1, researchCoverage: 4, externalSources: 0, charting: 3, relativeStrength: 2, aiRating: 2, growth: 2, relativeValuation: 3, historicalValuation: 2, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 2, catalysts: 3, trackRecord: 1, ownershipTrends: 1 },
    notes: "Tactical fit is strong in inflation, geopolitics, and risk-off rotation.",
  },
  {
    ticker: "XLU",
    name: "Utilities Select Sector SPDR",
    bucket: "Watchlist",
    sector: "Utilities",
    beta: 0.48,
    weights: { portfolio: 0 },
    scores: { brand: 1, secular: 0, researchCoverage: 4, externalSources: 0, charting: 2, relativeStrength: 2, aiRating: 2, growth: 1, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 0, catalysts: 1, trackRecord: 1, ownershipTrends: 1 },
    notes: "Useful defensive ballast when PMs need capital preservation over beta exposure.",
  },
  {
    ticker: "MDT",
    name: "Medtronic plc",
    bucket: "Portfolio",
    sector: "Health Care",
    beta: 0.78,
    weights: { portfolio: 3.0 },
    scores: { brand: 1, secular: 1, researchCoverage: 3, externalSources: 0, charting: 1, relativeStrength: 0, aiRating: 0, growth: 1, relativeValuation: 2, historicalValuation: 1, leverageCoverage: 1, cashFlowQuality: 1, competitiveMoat: 1, turnaround: 1, catalysts: 1, trackRecord: 1, ownershipTrends: 0 },
    notes: "Turnaround story with new CEO. Pipeline refresh underway but execution risk remains.",
  },
];

export function StockProvider({ children }: { children: React.ReactNode }) {
  const [stocks, setStocks] = useState<Stock[]>(holdingsSeed);
  const [marketData, setMarketData] = useState<MarketData>(defaultMarketData);
  const [brief, setBrief] = useState<MorningBrief | null>(null);

  const scoredStocks = useMemo(
    () => stocks.map((s) => computeScores(s, marketData)),
    [stocks, marketData]
  );

  const portfolioStocks = useMemo(
    () => scoredStocks
      .filter((s) => s.bucket === "Portfolio")
      .sort((a, b) => b.adjusted - a.adjusted),
    [scoredStocks]
  );

  const watchlistStocks = useMemo(
    () => scoredStocks
      .filter((s) => s.bucket === "Watchlist")
      .sort((a, b) => b.adjusted - a.adjusted),
    [scoredStocks]
  );

  const offensiveExposure = useMemo(
    () =>
      scoredStocks
        .filter((s) => s.bucket === "Portfolio" && isOffensiveSector(s.sector))
        .reduce((sum, s) => sum + s.weights.portfolio, 0),
    [scoredStocks]
  );

  const addStock = useCallback((stock: Stock) => {
    setStocks((prev) => [stock, ...prev]);
  }, []);

  const removeStock = useCallback((ticker: string) => {
    setStocks((prev) => prev.filter((s) => s.ticker !== ticker));
  }, []);

  const moveBucket = useCallback((ticker: string) => {
    setStocks((prev) =>
      prev.map((s) =>
        s.ticker === ticker
          ? {
              ...s,
              bucket: s.bucket === "Portfolio" ? "Watchlist" : "Portfolio",
              weights: {
                portfolio: s.bucket === "Portfolio" ? 0 : 2,
              },
            }
          : s
      )
    );
  }, []);

  const updateScore = useCallback((ticker: string, key: ScoreKey, value: number) => {
    setStocks((prev) =>
      prev.map((s) =>
        s.ticker === ticker
          ? { ...s, scores: { ...s.scores, [key]: value } }
          : s
      )
    );
  }, []);

  const updateSector = useCallback((ticker: string, sector: string) => {
    setStocks((prev) =>
      prev.map((s) => (s.ticker === ticker ? { ...s, sector } : s))
    );
  }, []);

  const updateMarketData = useCallback((updates: Partial<MarketData>) => {
    setMarketData((prev) => ({ ...prev, ...updates }));
  }, []);

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
        offensiveExposure,
        addStock,
        removeStock,
        moveBucket,
        updateScore,
        updateSector,
        setBrief,
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
