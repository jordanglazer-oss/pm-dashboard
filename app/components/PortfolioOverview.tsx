"use client";

import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, MAX_SCORE, INSTRUMENT_LABELS } from "@/app/lib/types";
import type { ScoredStock, ScoreKey } from "@/app/lib/types";
import { groupTotal, isScoreable } from "@/app/lib/scoring";
import { SignalPill } from "./SignalPill";

// S&P 500 fallback sector weights (used when live SPY data is unavailable)
const SP500_WEIGHTS_FALLBACK: Record<string, number> = {
  Technology: 32,
  "Health Care": 12,
  Financials: 13,
  "Consumer Discretionary": 10,
  "Communication Services": 9,
  Industrials: 9,
  "Consumer Staples": 6,
  Energy: 4,
  Utilities: 2,
  "Real Estate": 2,
  Materials: 2,
};

// Normalize sector names — Yahoo uses different names than GICS standard
// e.g., "Consumer Cyclical" vs "Consumer Discretionary", "Financial Services" vs "Financials"
function normalizeSector(sector: string): string {
  const map: Record<string, string> = {
    "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples",
    "Financial Services": "Financials",
    "Basic Materials": "Materials",
    "Healthcare": "Health Care",
  };
  return map[sector] || sector;
}

// Distinct colors for each GICS sector — all visually distinguishable
const sectorColors: Record<string, string> = {
  Technology: "bg-blue-600",
  Financials: "bg-teal-500",
  Energy: "bg-red-500",
  "Consumer Staples": "bg-amber-500",
  "Consumer Discretionary": "bg-orange-500",
  "Health Care": "bg-purple-500",
  Industrials: "bg-slate-500",
  "Communication Services": "bg-indigo-500",
  Utilities: "bg-lime-500",
  Materials: "bg-cyan-500",
  "Real Estate": "bg-pink-500",
};

function fundReturnFmt(val: number | undefined): string {
  if (val == null) return "—";
  return `${val >= 0 ? "+" : ""}${val.toFixed(1)}%`;
}

function fundReturnColor(val: number | undefined): string {
  if (val == null) return "text-slate-400";
  return val >= 0 ? "text-emerald-600" : "text-red-500";
}

function ratingColor(label: string): string {
  if (label.includes("Buy")) return "text-emerald-600";
  if (label.includes("Underweight")) return "text-amber-600";
  if (label === "Sell") return "text-red-600";
  return "text-slate-700";
}

type DashboardFilter = "all" | "stocks" | "etf-usd" | "etf-cad" | "mutual-fund";

const DASH_FILTER_LABELS: Record<DashboardFilter, string> = {
  all: "All",
  stocks: "Stocks",
  "etf-usd": "ETFs (USD)",
  "etf-cad": "ETFs (CAD)",
  "mutual-fund": "Mutual Funds",
};

function isCanadianTicker(ticker: string): boolean {
  // .U suffix = USD-denominated Canadian-listed ETF (e.g., XUS.U, XUU.U) — NOT Canadian
  if (ticker.endsWith(".U")) return false;
  return ticker.endsWith(".TO") || /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

function matchesDashFilter(s: ScoredStock, filter: DashboardFilter): boolean {
  if (filter === "all") return true;
  if (filter === "stocks") return !s.instrumentType || s.instrumentType === "stock";
  if (filter === "etf-usd") return s.instrumentType === "etf" && !isCanadianTicker(s.ticker);
  if (filter === "etf-cad") return s.instrumentType === "etf" && isCanadianTicker(s.ticker);
  if (filter === "mutual-fund") return s.instrumentType === "mutual-fund";
  return true;
}

type FundSortField = "ticker" | "name" | "type" | "role" | "weight" | "price" | "ytd" | "oneYear" | "threeYear" | "fiveYear" | "tenYear";
type SortDir = "asc" | "desc";

function FundSortIcon({ field, sortField, sortDir }: { field: FundSortField; sortField: FundSortField; sortDir: SortDir }) {
  if (field !== sortField) {
    return (
      <svg className="w-3 h-3 ml-0.5 inline opacity-30" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4-4 4 4M16 15l-4 4-4-4" />
      </svg>
    );
  }
  return sortDir === "asc" ? (
    <svg className="w-3 h-3 ml-0.5 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 15l4-4 4 4" />
    </svg>
  ) : (
    <svg className="w-3 h-3 ml-0.5 inline" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M8 9l4 4 4-4" />
    </svg>
  );
}

function InlineWeightEditor({ ticker, currentWeight, onSave }: { ticker: string; currentWeight: number; onSave: (ticker: string, w: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(currentWeight));
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  // Sync if external value changes while not editing
  useEffect(() => {
    if (!editing) setValue(String(currentWeight));
  }, [currentWeight, editing]);

  const commit = useCallback(() => {
    const parsed = parseFloat(value);
    if (!isNaN(parsed) && parsed >= 0) {
      onSave(ticker, parsed);
    }
    setEditing(false);
  }, [value, ticker, onSave]);

  if (!editing) {
    return (
      <button
        onClick={() => { setValue(String(currentWeight)); setEditing(true); }}
        className="font-semibold text-slate-700 hover:text-blue-600 hover:underline decoration-dashed transition-colors cursor-pointer"
        title="Click to edit weight"
      >
        {currentWeight}%
      </button>
    );
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); commit(); }}
      className="flex items-center gap-1"
    >
      <input
        ref={inputRef}
        type="number"
        step="0.1"
        min="0"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === "Escape") setEditing(false); }}
        className="w-16 rounded border border-blue-300 bg-blue-50 px-1.5 py-0.5 text-right text-xs font-semibold text-slate-800 outline-none focus:ring-1 focus:ring-blue-300"
      />
      <span className="text-xs text-slate-400">%</span>
    </form>
  );
}

export function PortfolioOverview() {
  const { portfolioStocks, watchlistStocks, scoredStocks, marketData, updateWeight, updateStockFields } = useStocks();
  const [dashFilter, setDashFilter] = useState<DashboardFilter>("all");
  const [fundSort, setFundSort] = useState<FundSortField>("weight");
  const [fundSortDir, setFundSortDir] = useState<SortDir>("desc");

  // Apply instrument filter first
  const filteredPortfolio = portfolioStocks.filter((s) => matchesDashFilter(s, dashFilter));
  const filteredWatchlist = watchlistStocks.filter((s) => matchesDashFilter(s, dashFilter));

  // Separate scoreable stocks from funds
  const scoreablePortfolio = filteredPortfolio.filter((s) => isScoreable(s));
  const fundPortfolio = filteredPortfolio.filter((s) => !isScoreable(s));
  const scoreableWatchlist = filteredWatchlist.filter((s) => isScoreable(s));
  const allScoreable = [...scoreablePortfolio, ...scoreableWatchlist].sort((a, b) => b.adjusted - a.adjusted);

  // Compute counts across ALL stocks (unfiltered) for filter badges
  const allStocks = [...portfolioStocks, ...watchlistStocks];
  const filterCounts: Record<DashboardFilter, number> = { all: allStocks.length, stocks: 0, "etf-usd": 0, "etf-cad": 0, "mutual-fund": 0 };
  for (const s of allStocks) {
    if (!s.instrumentType || s.instrumentType === "stock") filterCounts.stocks++;
    else if (s.instrumentType === "etf" && !isCanadianTicker(s.ticker)) filterCounts["etf-usd"]++;
    else if (s.instrumentType === "etf" && isCanadianTicker(s.ticker)) filterCounts["etf-cad"]++;
    else if (s.instrumentType === "mutual-fund") filterCounts["mutual-fund"]++;
  }

  // S&P 500 sector weights — use live data from marketData if available, else fallback
  const sp500Weights = marketData.sp500SectorWeights || SP500_WEIGHTS_FALLBACK;

  // Sector exposure — Alpha picks only (excludes Core indexed holdings)
  // Normalize sector names so Yahoo variants map to GICS standard
  const alphaPortfolio = scoreablePortfolio.filter((s) => s.designation !== "core");
  const pfCount = scoreablePortfolio.length;
  const alphaCount = alphaPortfolio.length;
  const sectorCounts: Record<string, number> = {};
  alphaPortfolio.forEach((s) => {
    const normalized = normalizeSector(s.sector);
    sectorCounts[normalized] = (sectorCounts[normalized] || 0) + 1;
  });
  const sectorExposure = Object.entries(sectorCounts)
    .map(([sector, count]) => ({
      sector,
      weight: alphaCount > 0 ? Math.round((count / alphaCount) * 100) : 0,
      count,
    }))
    .sort((a, b) => b.weight - a.weight);

  // Action items (only for scoreable stocks)
  const bottomPortfolio = [...scoreablePortfolio].reverse().slice(0, 3);
  const topWatchlist = scoreableWatchlist.slice(0, 3);
  const reviewCount = bottomPortfolio.filter((s) => s.adjusted < 20).length;
  const buyCount = topWatchlist.filter((s) => s.adjusted >= 18).length;

  // Averages (only for scoreable stocks)
  const pfAvgBase = pfCount > 0 ? Math.round(scoreablePortfolio.reduce((s, x) => s + x.raw, 0) / pfCount) : 0;
  const pfAvgAdj = pfCount > 0 ? Math.round(scoreablePortfolio.reduce((s, x) => s + x.adjusted, 0) / pfCount) : 0;
  const wlCount = scoreableWatchlist.length;
  const wlAvgBase = wlCount > 0 ? Math.round(scoreableWatchlist.reduce((s, x) => s + x.raw, 0) / wlCount) : 0;
  const wlAvgAdj = wlCount > 0 ? Math.round(scoreableWatchlist.reduce((s, x) => s + x.adjusted, 0) / wlCount) : 0;
  const totalFundWeight = fundPortfolio.reduce((s, x) => s + x.weights.portfolio, 0);

  return (
    <div className="space-y-6">
      {/* Instrument Type Filter */}
      <div className="flex items-center gap-1 flex-wrap">
        {(Object.keys(DASH_FILTER_LABELS) as DashboardFilter[]).map((key) => {
          const count = filterCounts[key];
          if (key !== "all" && count === 0) return null;
          const active = dashFilter === key;
          return (
            <button
              key={key}
              onClick={() => setDashFilter(key)}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                active
                  ? "bg-slate-800 text-white shadow-sm"
                  : "bg-slate-100 text-slate-500 hover:bg-slate-200 hover:text-slate-700"
              }`}
            >
              {DASH_FILTER_LABELS[key]}
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-bold ${active ? "bg-white/20 text-white" : "bg-slate-200 text-slate-500"}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Sector Exposure */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <h2 className="text-lg font-bold text-slate-800">Portfolio Sector Exposure</h2>
          <span className="text-sm text-slate-400">Alpha picks only · {alphaCount} stocks (equal-weighted)</span>
        </div>
        <div className="flex h-8 rounded-xl overflow-hidden mb-3">
          {sectorExposure.map((s) => (
            <div
              key={s.sector}
              className={`${sectorColors[s.sector] || "bg-slate-400"} flex items-center justify-center text-[11px] font-semibold text-white`}
              style={{ width: `${s.weight}%` }}
            >
              {s.weight >= 8 && `${s.weight}%`}
            </div>
          ))}
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mb-4">
          {sectorExposure.map((s) => (
            <span key={s.sector} className="flex items-center gap-1.5">
              <span className={`h-2 w-2 rounded-full ${sectorColors[s.sector] || "bg-slate-400"}`} />
              {s.sector} {s.weight}% ({s.count})
            </span>
          ))}
        </div>
        {/* Over/Underweight vs S&P */}
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {sectorExposure.map((s) => {
            const spWeight = sp500Weights[s.sector] || 0;
            const diff = s.weight - spWeight;
            return (
              <div key={s.sector} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-1.5">
                <span className="text-xs text-slate-600">{s.sector}</span>
                <span className={`text-xs font-semibold ${diff > 0 ? "text-emerald-600" : diff < 0 ? "text-red-500" : "text-slate-400"}`}>
                  {diff > 0 ? "+" : ""}{parseFloat(diff.toFixed(1))}% vs S&P
                </span>
              </div>
            );
          })}
        </div>
      </section>

      {/* Summary Cards */}
      <section className="grid gap-4 md:grid-cols-3 xl:grid-cols-4">
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Stocks</div>
          <div className="mt-2 text-4xl font-bold text-slate-900">{pfCount}</div>
          <div className="mt-1 text-sm text-slate-500">Avg adj: {pfAvgAdj} (base: {pfAvgBase})</div>
        </div>
        {fundPortfolio.length > 0 && (
          <div className="rounded-[24px] border border-indigo-200 bg-indigo-50/50 p-5 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wider text-indigo-400">Funds / ETFs</div>
            <div className="mt-2 text-4xl font-bold text-indigo-700">{fundPortfolio.length}</div>
            <div className="mt-1 text-sm text-indigo-500">Total weight: {totalFundWeight.toFixed(1)}%</div>
          </div>
        )}
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Watchlist</div>
          <div className="mt-2 text-4xl font-bold text-slate-900">{wlCount}</div>
          <div className="mt-1 text-sm text-slate-500">Avg adj: {wlAvgAdj} (base: {wlAvgBase})</div>
        </div>
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">Action Items</div>
          <div className="mt-2 text-4xl font-bold text-amber-600">{reviewCount + buyCount}</div>
          <div className="mt-1 text-sm text-slate-500">{reviewCount} review · {buyCount} buy candidates</div>
        </div>
      </section>

      {/* Fund Holdings */}
      {fundPortfolio.length > 0 && (() => {
        const handleFundSort = (field: FundSortField) => {
          if (fundSort === field) {
            setFundSortDir((d) => (d === "asc" ? "desc" : "asc"));
          } else {
            setFundSort(field);
            setFundSortDir(field === "ticker" || field === "name" || field === "type" || field === "role" ? "asc" : "desc");
          }
        };

        const sortedFunds = [...fundPortfolio].sort((a, b) => {
          let cmp = 0;
          const perfA = a.fundData?.performance;
          const perfB = b.fundData?.performance;
          switch (fundSort) {
            case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
            case "name": cmp = a.name.localeCompare(b.name); break;
            case "type": cmp = (a.instrumentType || "").localeCompare(b.instrumentType || ""); break;
            case "role": cmp = (a.designation || "alpha").localeCompare(b.designation || "alpha"); break;
            case "weight": cmp = a.weights.portfolio - b.weights.portfolio; break;
            case "price": cmp = (a.price ?? -1) - (b.price ?? -1); break;
            case "ytd": cmp = (perfA?.ytd ?? -999) - (perfB?.ytd ?? -999); break;
            case "oneYear": cmp = (perfA?.oneYear ?? -999) - (perfB?.oneYear ?? -999); break;
            case "threeYear": cmp = (perfA?.threeYear ?? -999) - (perfB?.threeYear ?? -999); break;
            case "fiveYear": cmp = (perfA?.fiveYear ?? -999) - (perfB?.fiveYear ?? -999); break;
            case "tenYear": cmp = (perfA?.tenYear ?? -999) - (perfB?.tenYear ?? -999); break;
          }
          return fundSortDir === "asc" ? cmp : -cmp;
        });

        const fThClass = "pb-2 font-semibold cursor-pointer select-none hover:text-slate-800 transition-colors whitespace-nowrap";

        return (
          <section className="rounded-[30px] border border-indigo-200 bg-white p-5 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold text-slate-800">Fund & ETF Holdings</h2>
              <span className="text-sm text-slate-400">{fundPortfolio.length} holdings · {totalFundWeight.toFixed(1)}% total weight</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[800px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs text-slate-500">
                    <th className={fThClass} onClick={() => handleFundSort("ticker")}>
                      Ticker<FundSortIcon field="ticker" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={fThClass} onClick={() => handleFundSort("name")}>
                      Name<FundSortIcon field="name" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={fThClass} onClick={() => handleFundSort("type")}>
                      Type<FundSortIcon field="type" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={fThClass} onClick={() => handleFundSort("role")}>
                      Role<FundSortIcon field="role" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("weight")}>
                      Weight<FundSortIcon field="weight" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("price")}>
                      Price<FundSortIcon field="price" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("ytd")}>
                      YTD<FundSortIcon field="ytd" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("oneYear")}>
                      1Y<FundSortIcon field="oneYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("threeYear")}>
                      3Y<FundSortIcon field="threeYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("fiveYear")}>
                      5Y<FundSortIcon field="fiveYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                    <th className={`text-right ${fThClass}`} onClick={() => handleFundSort("tenYear")}>
                      10Y<FundSortIcon field="tenYear" sortField={fundSort} sortDir={fundSortDir} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {sortedFunds.map((s) => {
                    const perf = s.fundData?.performance;
                    return (
                      <tr key={s.ticker} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                        <td className="py-3">
                          <Link href={`/stock/${s.ticker.toLowerCase()}`} className="font-bold text-slate-800 hover:underline font-mono">
                            {s.ticker}
                          </Link>
                        </td>
                        <td className="py-3 text-slate-600 max-w-[180px] truncate">{s.name}</td>
                        <td className="py-3">
                          <span className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${s.instrumentType === "etf" ? "bg-indigo-100 text-indigo-700" : "bg-purple-100 text-purple-700"}`}>
                            {INSTRUMENT_LABELS[s.instrumentType || "stock"]}
                          </span>
                        </td>
                        <td className="py-3">
                          {(() => {
                            // Only show Core/Alpha for equity-class ETFs/MFs
                            const nl = (s.name || "").toLowerCase();
                            const sl = (s.sector || "").toLowerCase();
                            const isBondOrAlt = sl.includes("bond") || sl.includes("fixed") || nl.includes("bond") || nl.includes("fixed income")
                              || sl.includes("alternative") || nl.includes("alternative") || nl.includes("premium yield") || nl.includes("premium income") || nl.includes("hedge") || nl.includes("option income") || nl.includes("option writing") || nl.includes("covered call");
                            if (isBondOrAlt) return <span className="text-[10px] text-slate-300">—</span>;
                            return (
                              <button
                                onClick={() => updateStockFields(s.ticker, { designation: (s.designation || "alpha") === "core" ? "alpha" : "core" })}
                                className={`rounded-md px-2 py-0.5 text-[10px] font-bold transition-colors ${
                                  (s.designation || "alpha") === "core"
                                    ? "bg-blue-100 text-blue-700 hover:bg-blue-200"
                                    : "bg-amber-100 text-amber-700 hover:bg-amber-200"
                                }`}
                              >
                                {(s.designation || "alpha") === "core" ? "Core" : "Alpha"}
                              </button>
                            );
                          })()}
                        </td>
                        <td className="py-3 text-right">
                          <InlineWeightEditor ticker={s.ticker} currentWeight={s.weights.portfolio} onSave={updateWeight} />
                        </td>
                        <td className="py-3 text-right text-slate-600">{s.price != null ? `$${s.price.toFixed(2)}` : "—"}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.ytd)}`}>{fundReturnFmt(perf?.ytd)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.oneYear)}`}>{fundReturnFmt(perf?.oneYear)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.threeYear)}`}>{fundReturnFmt(perf?.threeYear)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.fiveYear)}`}>{fundReturnFmt(perf?.fiveYear)}</td>
                        <td className={`py-3 text-right text-xs font-semibold ${fundReturnColor(perf?.tenYear)}`}>{fundReturnFmt(perf?.tenYear)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        );
      })()}

      {/* Portfolio Rankings (scoreable stocks only) */}
      <RankingTable title="Portfolio Rankings" subtitle="Bottom 3 flagged for review" stocks={scoreablePortfolio} flagType="review" />

      {/* Watchlist Rankings (scoreable stocks only) */}
      <RankingTable title="Watchlist Rankings" subtitle="Top 3 flagged as buy candidates" stocks={scoreableWatchlist} flagType="buy" />

      {/* Score Comparison (scoreable stocks only) */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-800 mb-4">Score Comparison</h2>
        <div className="space-y-2">
          {allScoreable.map((s) => {
            const pct = (s.adjusted / MAX_SCORE) * 100;
            const adj = Math.round((s.adjusted - s.raw) * 10) / 10;
            const label = s.ratingLabel || s.rating;
            const barColor =
              s.adjusted >= 22
                ? "bg-gradient-to-r from-emerald-400 to-emerald-500"
                : s.adjusted >= 18
                ? "bg-gradient-to-r from-amber-300 to-amber-400"
                : "bg-gradient-to-r from-orange-400 to-red-400";

            return (
              <Link
                key={s.ticker}
                href={`/stock/${s.ticker.toLowerCase()}`}
                className="flex items-center gap-3 rounded-xl py-1.5 hover:bg-slate-50 transition-colors"
              >
                <span className="w-16 text-sm font-bold text-slate-800 text-right font-mono">{s.ticker}</span>
                <SignalPill tone={s.bucket === "Portfolio" ? "blue" : "gray"}>
                  {s.bucket === "Portfolio" ? "PF" : "WL"}
                </SignalPill>
                <div className="flex-1 h-6 rounded-full bg-slate-100 overflow-hidden relative">
                  <div
                    className={`h-full rounded-full ${barColor} flex items-center justify-end pr-2`}
                    style={{ width: `${Math.max(pct, 5)}%` }}
                  >
                    <span className="text-xs font-bold text-white">{s.adjusted}</span>
                  </div>
                </div>
                <span className={`w-6 text-xs font-semibold ${adj >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {adj >= 0 ? "+" : ""}{adj}
                </span>
                <span className={`w-24 text-xs font-medium text-right ${ratingColor(label)}`}>
                  {label}
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}

type RankingSortKey = "ticker" | "raw" | "adjusted" | "rating" | string;

function RankingTable({
  title,
  subtitle,
  stocks,
  flagType,
}: {
  title: string;
  subtitle: string;
  stocks: ScoredStock[];
  flagType: "review" | "buy";
}) {
  const [sort, setSort] = useState<{ key: RankingSortKey; dir: SortDir }>({ key: "adjusted", dir: "desc" });

  const GROUP_HEADER_COLORS: Record<string, string> = {
    "Long-term": "text-blue-600",
    Research: "text-purple-600",
    Technicals: "text-teal-600",
    Fundamental: "text-emerald-600",
    "Company Specific": "text-amber-600",
    Management: "text-red-600",
  };

  function toggleSort(key: RankingSortKey) {
    setSort((prev) => prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" });
  }

  const arrow = (key: RankingSortKey) => sort.key === key ? (sort.dir === "asc" ? " \u25B2" : " \u25BC") : "";

  const sorted = [...stocks].sort((a, b) => {
    const { key, dir } = sort;
    let cmp = 0;
    if (key === "ticker") {
      cmp = a.ticker.localeCompare(b.ticker);
    } else if (key === "raw") {
      cmp = a.raw - b.raw;
    } else if (key === "adjusted") {
      cmp = a.adjusted - b.adjusted;
    } else if (key === "rating") {
      const order = { "Sell": 0, "Underweight": 1, "Hold": 2, "Moderate Buy": 3, "Strong Buy": 4 };
      cmp = (order[(a.ratingLabel || a.rating) as keyof typeof order] ?? 2) - (order[(b.ratingLabel || b.rating) as keyof typeof order] ?? 2);
    } else {
      // Score group sort
      const group = SCORE_GROUPS.find((g) => g.name === key);
      if (group) {
        cmp = groupTotal(a, group) - groupTotal(b, group);
      }
    }
    return dir === "asc" ? cmp : -cmp;
  });

  const thClass = "pb-2 cursor-pointer hover:text-slate-800 select-none";

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-slate-800">{title}</h2>
        <span className="text-sm text-slate-400">{subtitle}</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-500">
              <th className="pb-2 w-8">#</th>
              <th className={thClass} onClick={() => toggleSort("ticker")}>Ticker{arrow("ticker")}</th>
              {SCORE_GROUPS.map((g) => (
                <th key={g.name} className={`${thClass} ${GROUP_HEADER_COLORS[g.name] || ""}`} onClick={() => toggleSort(g.name)}>
                  {g.name === "Company Specific" ? "Company" : g.name}{arrow(g.name)}
                </th>
              ))}
              <th className={thClass} onClick={() => toggleSort("raw")}>Base{arrow("raw")}</th>
              <th className={`${thClass} font-bold`} onClick={() => toggleSort("adjusted")}>Adj{arrow("adjusted")}</th>
              <th className={thClass} onClick={() => toggleSort("rating")}>Rating{arrow("rating")}</th>
              <th className="pb-2">Signal</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s, i) => {
              const adj = Math.round((s.adjusted - s.raw) * 10) / 10;
              const label = s.ratingLabel || s.rating;
              const isFlagged =
                flagType === "review" ? i >= sorted.length - 3 : i < 3;

              return (
                <tr key={s.ticker} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                  <td className="py-3 text-slate-400">{i + 1}</td>
                  <td className="py-3">
                    <Link href={`/stock/${s.ticker.toLowerCase()}`} className="hover:underline">
                      <div className="font-bold text-slate-800">{s.ticker}</div>
                      <div className="text-xs text-slate-400">{s.name}</div>
                    </Link>
                  </td>
                  {SCORE_GROUPS.map((g) => (
                    <td key={g.name} className="py-3 text-slate-600">
                      {groupTotal(s, g)}/{g.maxTotal}
                    </td>
                  ))}
                  <td className="py-3 text-slate-500">{s.raw}</td>
                  <td className="py-3">
                    <span className="font-bold text-slate-900">{s.adjusted}</span>
                    <span className={`ml-0.5 text-xs ${adj >= 0 ? "text-emerald-500" : "text-red-500"}`}>
                      {adj >= 0 ? "+" : ""}{adj}
                    </span>
                  </td>
                  <td className={`py-3 font-medium ${ratingColor(label)}`}>{label}</td>
                  <td className="py-3">
                    {isFlagged && flagType === "buy" && (
                      <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-600">
                        BUY CANDIDATE
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
