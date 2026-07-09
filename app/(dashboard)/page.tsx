"use client";

import React, { useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PortfolioOverview } from "@/app/components/PortfolioOverview";
import { RegimeStrip } from "@/app/components/RegimeStrip";
import { ChangeMonitor } from "@/app/components/ChangeMonitor";
import { ScoreCalibration } from "@/app/components/ScoreCalibration";
import { ModelReturnsStrip } from "@/app/components/ModelReturnsStrip";
import { regimeMultiplier, isOffensiveSector, normalizeSector } from "@/app/lib/scoring";
import type { Stock, ScoreKey, InstrumentType } from "@/app/lib/types";
import { INSTRUMENT_LABELS } from "@/app/lib/types";
import { displayTicker } from "@/app/lib/ticker";

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

export default function DashboardPage() {
  const { scoredStocks, marketData, addStock, uiPrefs, setUiPref } = useStocks();
  const [newTicker, setNewTicker] = useState("");
  const [newBucket, setNewBucket] = useState<"Portfolio" | "Watchlist">("Watchlist");
  const [detectedType, setDetectedType] = useState<InstrumentType | null>(null);
  const [newWeight, setNewWeight] = useState("");
  const [adding, setAdding] = useState(false);

  const regime = marketData.riskRegime;

  // Portfolio β is now rendered inside PortfolioOverview next to the
  // Sector Exposure header — kept alongside other portfolio-level risk
  // context rather than in the market regime card.

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
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">

        {/* Per-PIM-model day return strip (Balanced/Growth/All-Equity/Alpha/Core).
            Replaces the old value/holdings/cash tiles per the redesign. */}
        <ModelReturnsStrip />

        {/* Deterministic regime pulse — sits above the manual regime
            card so the PM gets the Yahoo-derived cross-asset read at a
            glance before scanning the fundamentals below. Reads
            /api/market-regime which is cached in pm:market-regime; the
            strip silently hides on fetch failure. */}
        <RegimeStrip />

        {/* Change monitor moved into the Rankings cockpit's right sidebar
            (passed to PortfolioOverview below) alongside Sector Exposure. */}

        {/* ── Add Stock + Regime Banner ── */}
        <div className="grid gap-4 lg:grid-cols-2">

          {/* Add Holding Card */}
          <div className="rounded-card border border-line bg-surface p-5 shadow-sm">
            <h2 className="text-lg font-bold text-ink mb-3">Add a Holding</h2>
            <p className="text-sm text-ink-2 mb-4">
              Enter a ticker (stock, ETF) or FUNDSERV code (Canadian mutual fund, e.g. TDB900) to add.
              {detectedType && detectedType !== "stock" ? (
                <span className="text-warn font-medium"> Auto-scoring is not available for {INSTRUMENT_LABELS[detectedType]}s — use the weight field to set the allocation.</span>
              ) : (
                <> Use the <span className="font-semibold text-accent">Score</span> button on the stock page to auto-score with Claude.</>
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
                  className="w-full rounded-control border border-line bg-surface px-4 py-2.5 text-sm outline-none placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent-soft"
                />
                {detectedType && detectedType !== "stock" && (
                  <span className={`absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-0.5 text-[10px] font-bold ${detectedType === "etf" ? "bg-accent-soft text-accent-ink" : "bg-violet-soft text-violet"}`}>
                    {INSTRUMENT_LABELS[detectedType]}
                  </span>
                )}
              </div>
              <select
                value={newBucket}
                onChange={(e) => setNewBucket(e.target.value as "Portfolio" | "Watchlist")}
                className="rounded-control border border-line bg-surface px-3 py-2.5 text-sm"
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
                  className="w-24 rounded-control border border-line bg-surface px-3 py-2.5 text-sm outline-none placeholder:text-ink-3 focus:border-accent focus:ring-1 focus:ring-accent-soft"
                />
              )}
              <button
                onClick={handleAdd}
                disabled={adding}
                className="rounded-control bg-accent px-5 py-2.5 text-sm font-semibold text-white hover:bg-accent-ink transition-colors disabled:opacity-50"
              >
                {adding ? "Adding..." : "Add"}
              </button>
            </div>
          </div>

          {/* Regime Info Card */}
          <div className={`rounded-card border p-5 shadow-sm ${
            regime === "Risk-Off"
              ? "border-neg-border bg-neg-soft"
              : regime === "Neutral"
              ? "border-warn-border bg-warn-soft"
              : "border-pos-border bg-pos-soft"
          }`}>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold text-ink">Market Regime</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${
                regime === "Risk-Off"
                  ? "bg-neg-soft text-neg"
                  : regime === "Neutral"
                  ? "bg-warn-soft text-warn"
                  : "bg-pos-soft text-pos"
              }`}>
                {regime}
              </span>
            </div>

            {regime === "Risk-Off" && (
              <div className="space-y-2 text-sm text-ink">
                <p className="font-medium text-neg">
                  Defensive posture active — scores are adjusted by sector type:
                </p>
                <ul className="list-disc list-inside space-y-1 text-ink-2">
                  <li>
                    <span className="font-semibold text-neg">Growth sectors</span> (Tech, Comm Services, Consumer Disc) → <span className="font-bold">0.85x</span> — penalized for elevated drawdown risk.
                  </li>
                  <li>
                    <span className="font-semibold text-warn">Cyclical sectors</span> (Financials, Industrials, Materials) → <span className="font-bold">0.90x</span> — penalized for economic sensitivity.
                  </li>
                  <li>
                    <span className="font-semibold text-pos">Defensive sectors</span> (Utilities, Staples, Health Care) → <span className="font-bold">1.10x</span> — boosted for capital preservation.
                  </li>
                  <li>
                    Elevated volatility, wider credit spreads, and weak breadth — conditions support defensive positioning. See the Morning Brief for live readings.
                  </li>
                </ul>
                <a href="#regime-detail" className="mt-2 inline-block text-xs font-semibold text-neg hover:text-neg transition-colors">View per-stock regime detail ↓</a>
              </div>
            )}

            {regime === "Neutral" && (
              <div className="space-y-2 text-sm text-ink">
                <p className="font-medium text-warn">
                  Mixed environment — no regime adjustment applied:
                </p>
                <ul className="list-disc list-inside space-y-1 text-ink-2">
                  <li>
                    All sectors → <span className="font-bold">1.0x</span> — raw score equals adjusted score.
                  </li>
                  <li>
                    No strong signal — scores are driven entirely by fundamentals and quality. Cross-currents suggest balanced positioning until a clearer regime emerges. See the Morning Brief for live readings.
                  </li>
                </ul>
                <a href="#regime-detail" className="mt-2 inline-block text-xs font-semibold text-warn hover:text-warn transition-colors">View per-stock regime detail ↓</a>
              </div>
            )}

            {regime === "Risk-On" && (
              <div className="space-y-2 text-sm text-ink">
                <p className="font-medium text-pos">
                  Growth-favoring environment — scores tilted toward growth and cyclicals:
                </p>
                <ul className="list-disc list-inside space-y-1 text-ink-2">
                  <li>
                    <span className="font-semibold text-pos">Growth sectors</span> (Tech, Comm Services, Consumer Disc) → <span className="font-bold">1.10x</span> — boosted to reflect momentum and risk appetite.
                  </li>
                  <li>
                    <span className="font-semibold text-pos">Cyclical sectors</span> (Financials, Industrials, Materials) → <span className="font-bold">1.05x</span> — boosted for economic activity tailwind.
                  </li>
                  <li>
                    <span className="font-semibold text-warn">Defensive sectors</span> (Utilities, Staples, Health Care) → <span className="font-bold">0.92x</span> — penalized for opportunity cost in a risk-on environment.
                  </li>
                  <li>
                    Subdued volatility and healthy breadth — conditions favor full risk exposure and growth/cyclical tilt. See the Morning Brief for live readings.
                  </li>
                </ul>
                <a href="#regime-detail" className="mt-2 inline-block text-xs font-semibold text-pos hover:text-pos transition-colors">View per-stock regime detail ↓</a>
              </div>
            )}
          </div>
        </div>

        {/* ── Portfolio Overview ── */}
        <PortfolioOverview sidebar={<ChangeMonitor />} />

        {/* ── Regime Detail — per-stock multiplier breakdown ── */}
        {(() => {
          const regimeCollapsed = uiPrefs["dashboard.regimeMultiplier.collapsed"] === "1";
          const toggleRegimeCollapsed = () => setUiPref("dashboard.regimeMultiplier.collapsed", regimeCollapsed ? "0" : "1");
          return (
        <div id="regime-detail" className="scroll-mt-6">
          <section className="rounded-card border border-line bg-surface p-6 shadow-sm">
            <div className={`flex items-center gap-3 ${regimeCollapsed ? "" : "mb-4"}`}>
              <button
                onClick={toggleRegimeCollapsed}
                className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
                aria-expanded={!regimeCollapsed}
                aria-label={regimeCollapsed ? "Expand Regime Multiplier Detail" : "Collapse Regime Multiplier Detail"}
              >
                <svg className={`w-4 h-4 text-ink-3 transition-transform ${regimeCollapsed ? "-rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
                <h2 className="text-lg font-bold text-ink">Regime Multiplier Detail</h2>
              </button>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
                regime === "Risk-Off" ? "bg-neg-soft text-neg"
                : regime === "Neutral" ? "bg-warn-soft text-warn"
                : "bg-pos-soft text-pos"
              }`}>{regime}</span>
            </div>
            {!regimeCollapsed && (<>
            <p className="text-xs text-ink-3 mb-4">
              Each stock&apos;s regime multiplier is determined by its sector tier (Growth / Cyclical / Defensive) and dampened by its quality score (growth + leverage + cash flow quality + moat, max 8). Higher quality → softer regime effect.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b-2 border-line text-left">
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3">Ticker</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 hidden md:table-cell">Sector</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3">Tier</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Quality</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right hidden sm:table-cell">Base</th>
                    <th className="py-2 pr-3 text-xs font-semibold text-ink-3 text-right">Adj.</th>
                    <th className="py-2 text-xs font-semibold text-ink-3 text-right">Score</th>
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
                        tier === "Growth" ? "text-accent bg-accent-soft"
                        : tier === "Cyclical" ? "text-warn bg-warn-soft"
                        : tier === "Defensive" ? "text-pos bg-pos-soft"
                        : "text-ink-3 bg-surface-2";
                      const multColor = adjustedMultiplier < 1
                        ? "text-neg" : adjustedMultiplier > 1
                        ? "text-pos" : "text-ink-3";
                      return (
                        <tr key={s.ticker} className="border-b border-line-soft hover:bg-surface-hover transition-colors">
                          <td className="py-2 pr-3 font-mono font-bold text-ink">{displayTicker(s.ticker)}</td>
                          <td className="py-2 pr-3 text-ink-3 hidden md:table-cell">{normalized}</td>
                          <td className="py-2 pr-3">
                            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tierColor}`}>{tier}</span>
                          </td>
                          <td className="py-2 pr-3 text-right font-mono text-ink-2">{qualityScore}/8</td>
                          <td className="py-2 pr-3 text-right font-mono text-ink-3 hidden sm:table-cell">{baseMultiplier.toFixed(2)}x</td>
                          <td className={`py-2 pr-3 text-right font-mono font-semibold ${multColor}`}>{adjustedMultiplier.toFixed(3)}x</td>
                          <td className="py-2 text-right font-mono text-ink-3">
                            {Number(s.raw.toFixed(1))} → <span className="font-semibold text-ink">{Number(s.adjusted.toFixed(1))}</span>
                          </td>
                        </tr>
                      );
                    })}
                </tbody>
              </table>
            </div>
            </>)}
          </section>
        </div>
          );
        })()}

        {/* Score-calibration — "does the score actually predict returns?"
            Collapsed by default; computes on open (expensive Yahoo fetch,
            cached server-side in pm:score-calibration). */}
        <ScoreCalibration />
      </div>
    </main>
  );
}
