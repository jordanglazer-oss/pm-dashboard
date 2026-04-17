"use client";

import React, { useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PortfolioOverview } from "@/app/components/PortfolioOverview";
import { regimeMultiplier, isOffensiveSector, normalizeSector } from "@/app/lib/scoring";
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

  // Portfolio-level beta — individual stocks only, weighted by the per-stock
  // portfolio weight. ETFs and mutual funds are excluded because (a) their
  // betas are reported on a different basis (Morningstar BetaM36 vs equity
  // β), and (b) including them double-counts the stocks held inside the
  // fund. If per-stock weights don't sum to a positive number (e.g. all
  // zero), fall back to an equal-weighted average across the same stock
  // subset so the tile still renders something meaningful.
  const portfolioStocks = scoredStocks.filter((s) => s.bucket === "Portfolio");
  const portfolioBeta = (() => {
    const individualStocks = portfolioStocks.filter(
      (s) => !s.instrumentType || s.instrumentType === "stock"
    );
    if (individualStocks.length === 0) return null;
    const totalWeight = individualStocks.reduce(
      (sum, s) => sum + (s.weights.portfolio || 0),
      0
    );
    if (totalWeight > 0) {
      const weighted = individualStocks.reduce(
        (sum, s) => sum + s.beta * (s.weights.portfolio || 0),
        0
      );
      return weighted / totalWeight;
    }
    return (
      individualStocks.reduce((sum, s) => sum + s.beta, 0) /
      individualStocks.length
    );
  })();

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
                    <span className="font-semibold text-red-600">Growth sectors</span> (Tech, Comm Services, Consumer Disc) → <span className="font-bold">0.85x</span> — penalized for elevated drawdown risk.
                  </li>
                  <li>
                    <span className="font-semibold text-amber-600">Cyclical sectors</span> (Financials, Industrials, Materials) → <span className="font-bold">0.90x</span> — penalized for economic sensitivity.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-600">Defensive sectors</span> (Utilities, Staples, Health Care) → <span className="font-bold">1.10x</span> — boosted for capital preservation.
                  </li>
                  <li>
                    Elevated volatility, wider credit spreads, and weak breadth — conditions support defensive positioning. See the Morning Brief for live readings.
                  </li>
                </ul>
                <a href="#regime-detail" className="mt-2 inline-block text-xs font-semibold text-red-600 hover:text-red-800 transition-colors">View per-stock regime detail ↓</a>
              </div>
            )}

            {regime === "Neutral" && (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-amber-800">
                  Mixed environment — near-neutral regime adjustments applied:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>
                    <span className="font-semibold text-amber-700">Growth sectors</span> → <span className="font-bold">0.98x</span> — negligible headwind; fundamentals dominate.
                  </li>
                  <li>
                    <span className="font-semibold text-amber-600">Cyclical sectors</span> → <span className="font-bold">0.99x</span> — effectively neutral.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-600">Defensive sectors</span> → <span className="font-bold">1.01x</span> — effectively neutral.
                  </li>
                  <li>
                    No strong signal — scores are driven almost entirely by fundamentals and quality. Cross-currents suggest balanced positioning until a clearer regime emerges. See the Morning Brief for live readings.
                  </li>
                </ul>
                <a href="#regime-detail" className="mt-2 inline-block text-xs font-semibold text-amber-600 hover:text-amber-800 transition-colors">View per-stock regime detail ↓</a>
              </div>
            )}

            {regime === "Risk-On" && (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-emerald-800">
                  Growth-favoring environment — scores tilted toward growth and cyclicals:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>
                    <span className="font-semibold text-emerald-600">Growth sectors</span> (Tech, Comm Services, Consumer Disc) → <span className="font-bold">1.10x</span> — boosted to reflect momentum and risk appetite.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-500">Cyclical sectors</span> (Financials, Industrials, Materials) → <span className="font-bold">1.05x</span> — boosted for economic activity tailwind.
                  </li>
                  <li>
                    <span className="font-semibold text-amber-600">Defensive sectors</span> (Utilities, Staples, Health Care) → <span className="font-bold">0.92x</span> — penalized for opportunity cost in a risk-on environment.
                  </li>
                  <li>
                    Subdued volatility and healthy breadth — conditions favor full risk exposure and growth/cyclical tilt. See the Morning Brief for live readings.
                  </li>
                </ul>
                <a href="#regime-detail" className="mt-2 inline-block text-xs font-semibold text-emerald-600 hover:text-emerald-800 transition-colors">View per-stock regime detail ↓</a>
              </div>
            )}
          </div>
        </div>

        {/* ── Portfolio Overview ── */}
        <PortfolioOverview />

        {/* ── Regime Detail — per-stock multiplier breakdown ── */}
        <div id="regime-detail" className="scroll-mt-6">
          <section className="rounded-[24px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold text-slate-800">Regime Multiplier Detail</h2>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                regime === "Risk-Off" ? "bg-red-100 text-red-700"
                : regime === "Neutral" ? "bg-amber-100 text-amber-700"
                : "bg-emerald-100 text-emerald-700"
              }`}>{regime}</span>
            </div>
            <p className="text-xs text-slate-400 mb-4">
              Each stock&apos;s regime multiplier is determined by its sector tier (Growth / Cyclical / Defensive) and dampened by its quality score (growth + leverage + cash flow quality + moat, max 8). Higher quality → softer regime effect.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-slate-200 text-left">
                    <th className="py-2 pr-3 text-xs font-semibold text-slate-500">Ticker</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Sector</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-slate-500">Tier</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-slate-500 text-right">Quality</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-slate-500 text-right hidden sm:table-cell">Base</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-slate-500 text-right">Adj.</th>
                    <th className="py-2 text-xs font-semibold text-slate-500 text-right">Score</th>
                  </tr>
                </thead>
                <tbody>
                  {scoredStocks
                    .filter((s) => !s.instrumentType || s.instrumentType === "stock")
                    .sort((a, b) => {
                      const ma = regimeMultiplier(a.sector, regime, a.scores);
                      const mb = regimeMultiplier(b.sector, regime, b.scores);
                      return ma - mb; // most penalized first
                    })
                    .map((s) => {
                      const normalized = normalizeSector(s.sector);
                      const tier =
                        ["Technology", "Communication Services", "Consumer Discretionary"].includes(normalized) ? "Growth"
                        : ["Financials", "Industrials", "Materials", "Energy"].includes(normalized) ? "Cyclical"
                        : ["Utilities", "Consumer Staples", "Health Care"].includes(normalized) ? "Defensive"
                        : "Neutral";
                      const qualityKeys = ["growth", "leverageCoverage", "cashFlowQuality", "competitiveMoat"] as const;
                      const qualityScore = qualityKeys.reduce((sum, k) => sum + (s.scores[k] || 0), 0);
                      const baseMultiplier = regimeMultiplier(s.sector, regime); // no scores = base
                      const adjustedMultiplier = regimeMultiplier(s.sector, regime, s.scores);
                      const tierColor =
                        tier === "Growth" ? "text-blue-600 bg-blue-50"
                        : tier === "Cyclical" ? "text-amber-700 bg-amber-50"
                        : tier === "Defensive" ? "text-emerald-700 bg-emerald-50"
                        : "text-slate-500 bg-slate-50";
                      const multColor = adjustedMultiplier < 1
                        ? "text-red-600" : adjustedMultiplier > 1
                        ? "text-emerald-600" : "text-slate-500";
                      return (
                        <tr key={s.ticker} className="border-b border-slate-100 hover:bg-slate-50/50 transition-colors">
                          <td className="py-2 pr-3 font-mono font-bold text-slate-700">{s.ticker}</td>
                          <td className="py-2 pr-3 text-slate-500 hidden md:table-cell">{normalized}</td>
                          <td className="py-2 pr-3">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tierColor}`}>{tier}</span>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-slate-600">{qualityScore}/8</td>
                          <td className="py-2 pr-3 text-right font-mono text-slate-400 hidden sm:table-cell">{baseMultiplier.toFixed(2)}x</td>
                          <td className={`py-2 pr-3 text-right font-mono font-semibold ${multColor}`}>{adjustedMultiplier.toFixed(3)}x</td>
                          <td className="py-2 text-right font-mono text-slate-500">
                            {s.raw} → <span className="font-semibold text-slate-700">{s.adjusted}</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
