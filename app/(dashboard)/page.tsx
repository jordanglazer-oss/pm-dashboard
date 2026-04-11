"use client";

import React, { useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PortfolioOverview } from "@/app/components/PortfolioOverview";
import { regimeMultiplier, isOffensiveSector } from "@/app/lib/scoring";
import type { Stock, ScoreKey, InstrumentType } from "@/app/lib/types";
import { INSTRUMENT_LABELS } from "@/app/lib/types";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

export default function DashboardPage() {
  const { scoredStocks, marketData, addStock } = useStocks();
  const [newTicker, setNewTicker] = useState("");
  const [newBucket, setNewBucket] = useState<"Portfolio" | "Watchlist">("Watchlist");
  const [detectedType, setDetectedType] = useState<InstrumentType | null>(null);
  const [newWeight, setNewWeight] = useState("");
  const [adding, setAdding] = useState(false);

  const regime = marketData.riskRegime;

  // Portfolio-level beta
  const portfolioStocks = scoredStocks.filter((s) => s.bucket === "Portfolio");
  const portfolioBeta = portfolioStocks.length > 0
    ? portfolioStocks.reduce((sum, s) => sum + s.beta, 0) / portfolioStocks.length
    : null;

  async function handleAdd() {
    const ticker = newTicker.trim().toUpperCase();
    if (!ticker) return;
    if (scoredStocks.some((s) => s.ticker === ticker)) {
      alert(`${ticker} is already in your list.`);
      return;
    }

    setAdding(true);

    // Fetch company name, sector, and instrument type from Yahoo Finance
    let name = ticker;
    let sector = "Technology";
    let instrumentType: InstrumentType = detectedType || "stock";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.names?.[ticker]) name = data.names[ticker];
        if (data.sectors?.[ticker]) sector = data.sectors[ticker];
        if (data.types?.[ticker]) instrumentType = data.types[ticker] as InstrumentType;
      }
    } catch { /* fallback to ticker */ }

    const isFund = instrumentType === "etf" || instrumentType === "mutual-fund";
    const weight = isFund && newWeight ? parseFloat(newWeight) : (newBucket === "Portfolio" ? 2 : 0);

    const stock: Stock = {
      ticker,
      name,
      instrumentType,
      bucket: newBucket,
      sector: isFund ? "" : sector,
      beta: 1.0,
      weights: { portfolio: weight },
      scores: { ...ZERO_SCORES },
      notes: "",
    };
    addStock(stock);
    setNewTicker("");
    setNewWeight("");
    setDetectedType(null);
    setAdding(false);
  }

  // Auto-detect instrument type when ticker changes
  async function detectType(ticker: string) {
    if (!ticker || ticker.length < 1) { setDetectedType(null); return; }
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        const t = data.types?.[ticker] as InstrumentType | undefined;
        setDetectedType(t || null);
      }
    } catch { setDetectedType(null); }
  }

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">

        {/* ── Add Stock + Regime Banner ── */}
        <div className="grid gap-4 lg:grid-cols-2">

          {/* Add Holding Card */}
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-3">Add a Holding</h2>
            <p className="text-sm text-slate-500 mb-4">
              Enter a ticker (stock, ETF) or FUNDSERV code (Canadian mutual fund, e.g. TDB900) to add.
              {detectedType && detectedType !== "stock" ? (
                <span className="text-amber-600 font-medium"> Auto-scoring is not available for {INSTRUMENT_LABELS[detectedType]}s — use the weight field to set the allocation.</span>
              ) : (
                <> Use the <span className="font-semibold text-blue-600">Score</span> button on the stock page to auto-score with Claude.</>
              )}
            </p>
            <div className="flex flex-wrap gap-3">
              <div className="relative flex-1 min-w-[120px]">
                <input
                  value={newTicker}
                  onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                  onBlur={() => newTicker.trim() && detectType(newTicker.trim().toUpperCase())}
                  onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                  placeholder="e.g. AAPL, SPY, TDB900"
                  className="w-full rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                />
                {detectedType && detectedType !== "stock" && (
                  <span className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-0.5 text-[10px] font-bold ${detectedType === "etf" ? "bg-indigo-100 text-indigo-700" : "bg-purple-100 text-purple-700"}`}>
                    {INSTRUMENT_LABELS[detectedType]}
                  </span>
                )}
              </div>
              <select
                value={newBucket}
                onChange={(e) => setNewBucket(e.target.value as "Portfolio" | "Watchlist")}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
              >
                <option>Portfolio</option>
                <option>Watchlist</option>
              </select>
              {detectedType && detectedType !== "stock" && (
                <input
                  value={newWeight}
                  onChange={(e) => setNewWeight(e.target.value)}
                  placeholder="Weight %"
                  type="number"
                  step="0.1"
                  min="0"
                  className="w-24 rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                />
              )}
              <button
                onClick={handleAdd}
                disabled={adding}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {adding ? "Adding..." : "Add"}
              </button>
            </div>
          </div>

          {/* Regime Info Card */}
          <div className={`rounded-[24px] border p-5 shadow-sm ${
            regime === "Risk-Off"
              ? "border-red-200 bg-red-50"
              : regime === "Neutral"
              ? "border-amber-200 bg-amber-50"
              : "border-emerald-200 bg-emerald-50"
          }`}>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold text-slate-800">Market Regime</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${
                regime === "Risk-Off"
                  ? "bg-red-200 text-red-800"
                  : regime === "Neutral"
                  ? "bg-amber-200 text-amber-800"
                  : "bg-emerald-200 text-emerald-800"
              }`}>
                {regime}
              </span>
              {portfolioBeta != null && (
                <span className="rounded-full bg-white/60 px-3 py-1 text-xs font-bold text-slate-700">
                  Portfolio {"\u03B2"} {portfolioBeta.toFixed(2)}
                </span>
              )}
            </div>

            {regime === "Risk-Off" && (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-red-800">
                  Defensive posture active — scores are adjusted by sector type:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>
                    <span className="font-semibold text-red-600">Offensive sectors</span> (Tech, Comm Services, Consumer Disc) → <span className="font-bold">0.82x</span> — penalized for elevated drawdown risk.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-600">Defensive sectors</span> (Energy, Utilities, Staples, Financials, Materials, Industrials) → <span className="font-bold">1.10x</span> — boosted for capital preservation.
                  </li>
                  <li>
                    Elevated volatility, wider credit spreads, and weak breadth — conditions support defensive positioning. See the Morning Brief for live readings.
                  </li>
                </ul>
              </div>
            )}

            {regime === "Neutral" && (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-amber-800">
                  Mixed environment — mild regime adjustments applied:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>
                    <span className="font-semibold text-amber-700">Offensive sectors</span> → <span className="font-bold">0.95x</span> — slight headwind reflecting macro uncertainty.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-600">Defensive sectors</span> → <span className="font-bold">1.03x</span> — marginal safety premium.
                  </li>
                  <li>
                    Volatility and breadth send mixed signals — cross-currents suggest balanced positioning until a clearer signal emerges. See the Morning Brief for live readings.
                  </li>
                </ul>
              </div>
            )}

            {regime === "Risk-On" && (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-emerald-800">
                  Growth-favoring environment — scores tilted toward offensive sectors:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>
                    <span className="font-semibold text-emerald-600">Offensive sectors</span> (Tech, Comm Services, Consumer Disc) → <span className="font-bold">1.10x</span> — boosted to reflect momentum and risk appetite.
                  </li>
                  <li>
                    <span className="font-semibold text-amber-600">Defensive sectors</span> → <span className="font-bold">0.95x</span> — slight headwind as safety is less rewarded.
                  </li>
                  <li>
                    Subdued volatility and healthy breadth — conditions favor full risk exposure and growth/cyclical tilt. See the Morning Brief for live readings.
                  </li>
                </ul>
              </div>
            )}
          </div>
        </div>

        {/* ── Portfolio Overview ── */}
        <PortfolioOverview />
      </div>
    </main>
  );
}
