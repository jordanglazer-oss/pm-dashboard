"use client";

import React, { useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PortfolioOverview } from "@/app/components/PortfolioOverview";
import { regimeMultiplier, isOffensiveSector } from "@/app/lib/scoring";
import type { Stock, ScoreKey } from "@/app/lib/types";

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

  const regime = marketData.riskRegime;
  const isRiskOff = regime === "Risk-Off";

  function handleAdd() {
    const ticker = newTicker.trim().toUpperCase();
    if (!ticker) return;
    if (scoredStocks.some((s) => s.ticker === ticker)) {
      alert(`${ticker} is already in your list.`);
      return;
    }
    const stock: Stock = {
      ticker,
      name: ticker,
      bucket: newBucket,
      sector: "Technology",
      beta: 1.0,
      weights: { portfolio: newBucket === "Portfolio" ? 2 : 0 },
      scores: { ...ZERO_SCORES },
      notes: "",
    };
    addStock(stock);
    setNewTicker("");
  }

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">

        {/* ── Add Stock + Regime Banner ── */}
        <div className="grid gap-4 lg:grid-cols-2">

          {/* Add Stock Card */}
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-3">Add a Stock</h2>
            <p className="text-sm text-slate-500 mb-4">
              Enter a ticker to add it to your Portfolio or Watchlist. Scores start at zero — click into the stock to score categories manually, or use the <span className="font-semibold text-blue-600">Score</span> button on the stock page to auto-score with Claude.
            </p>
            <div className="flex gap-3">
              <input
                value={newTicker}
                onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
                onKeyDown={(e) => e.key === "Enter" && handleAdd()}
                placeholder="e.g. AAPL"
                className="flex-1 rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm outline-none placeholder:text-slate-400 focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
              />
              <select
                value={newBucket}
                onChange={(e) => setNewBucket(e.target.value as "Portfolio" | "Watchlist")}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm"
              >
                <option>Portfolio</option>
                <option>Watchlist</option>
              </select>
              <button
                onClick={handleAdd}
                className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
              >
                Add
              </button>
            </div>
          </div>

          {/* Regime Info Card */}
          <div className={`rounded-[24px] border p-5 shadow-sm ${
            isRiskOff
              ? "border-amber-200 bg-amber-50"
              : "border-emerald-200 bg-emerald-50"
          }`}>
            <div className="flex items-center gap-3 mb-3">
              <h2 className="text-lg font-bold text-slate-800">Market Regime</h2>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${
                isRiskOff
                  ? "bg-amber-200 text-amber-800"
                  : "bg-emerald-200 text-emerald-800"
              }`}>
                {regime}
              </span>
            </div>

            {isRiskOff ? (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-amber-800">
                  Defensive posture active — scores are adjusted by sector type:
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>
                    <span className="font-semibold text-red-600">Offensive sectors</span> (Tech, Comm Services, Consumer Disc) receive a <span className="font-bold">0.82x multiplier</span> — scores are penalized to reflect elevated drawdown risk in growth/cyclical names during stress.
                  </li>
                  <li>
                    <span className="font-semibold text-emerald-600">Defensive sectors</span> (Energy, Utilities, Staples, Financials, Materials, Industrials) receive a <span className="font-bold">1.10x multiplier</span> — scores are boosted to reflect their relative resilience and capital preservation characteristics.
                  </li>
                  <li>
                    VIX at {marketData.vix}, HY OAS at {marketData.hyOas}bps, breadth at {marketData.breadth}% — conditions support a risk-off stance and favor lower-beta, value-oriented positioning.
                  </li>
                </ul>
              </div>
            ) : (
              <div className="space-y-2 text-sm text-slate-700">
                <p className="font-medium text-emerald-800">
                  Risk-On — no regime adjustment applied to scores.
                </p>
                <ul className="list-disc list-inside space-y-1 text-slate-600">
                  <li>All sectors scored at face value (1.0x multiplier).</li>
                  <li>Growth and cyclical names are not penalized.</li>
                  <li>
                    VIX at {marketData.vix}, breadth at {marketData.breadth}% — conditions support full risk exposure.
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
