"use client";

import React, { useState, useMemo, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { ScoredStock, ScoreKey } from "@/app/lib/types";
import { MAX_SCORE } from "@/app/lib/types";
import { SignalPill, ratingTone, riskTone } from "./SignalPill";

type SortKey = "ticker" | "bucket" | "sector" | "raw" | "adjusted" | "rating" | "risk" | "effect" | "price" | "pnl";
type SortDir = "asc" | "desc";

type LivePrices = Record<string, number | null>;

type Props = {
  stocks: ScoredStock[];
  onScoreStock?: (ticker: string) => Promise<void>;
  onUpdateCostBasis?: (ticker: string, costBasis: number) => void;
};

const RATING_ORDER: Record<string, number> = { Buy: 3, Hold: 2, Sell: 1 };
const RISK_ORDER: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

export function StockScoring({ stocks, onScoreStock, onUpdateCostBasis }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("adjusted");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Live prices
  const [livePrices, setLivePrices] = useState<LivePrices>({});
  const [pricesLoading, setPricesLoading] = useState(false);
  const [pricesFetchedAt, setPricesFetchedAt] = useState<string | null>(null);

  // Score all state
  const [scoringAll, setScoringAll] = useState(false);
  const [scoreProgress, setScoreProgress] = useState("");

  const fetchPrices = useCallback(async () => {
    const tickers = stocks.map((s) => s.ticker);
    if (tickers.length === 0) return;
    setPricesLoading(true);
    try {
      const res = await fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      });
      if (res.ok) {
        const data = await res.json();
        setLivePrices(data.prices || {});
        setPricesFetchedAt(data.fetchedAt || new Date().toISOString());
      }
    } catch { /* silent */ } finally {
      setPricesLoading(false);
    }
  }, [stocks]);

  // Auto-fetch prices on mount
  useEffect(() => {
    fetchPrices();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Score all stocks sequentially
  async function handleScoreAll() {
    if (!onScoreStock || scoringAll) return;
    setScoringAll(true);
    for (let i = 0; i < stocks.length; i++) {
      const s = stocks[i];
      setScoreProgress(`Scoring ${s.ticker} (${i + 1}/${stocks.length})`);
      try {
        await onScoreStock(s.ticker);
      } catch { /* continue on error */ }
    }
    setScoreProgress("");
    setScoringAll(false);
    // Refresh prices after scoring
    fetchPrices();
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "ticker" || key === "bucket" || key === "sector" ? "asc" : "desc");
    }
  }

  // Portfolio beta (weighted by equal weight for now)
  const portfolioStocks = stocks.filter((s) => s.bucket === "Portfolio");
  const portfolioBeta = portfolioStocks.length > 0
    ? portfolioStocks.reduce((sum, s) => sum + s.beta, 0) / portfolioStocks.length
    : null;

  const sorted = useMemo(() => {
    const filtered = stocks.filter((s) =>
      `${s.ticker} ${s.name} ${s.sector} ${s.bucket}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "bucket": cmp = a.bucket.localeCompare(b.bucket); break;
        case "sector": cmp = a.sector.localeCompare(b.sector); break;
        case "raw": cmp = a.raw - b.raw; break;
        case "adjusted": cmp = a.adjusted - b.adjusted; break;
        case "rating": cmp = (RATING_ORDER[a.rating] || 0) - (RATING_ORDER[b.rating] || 0); break;
        case "risk": cmp = (RISK_ORDER[a.risk] || 0) - (RISK_ORDER[b.risk] || 0); break;
        case "effect": cmp = (a.adjusted - a.raw) - (b.adjusted - b.raw); break;
        case "price": cmp = (livePrices[a.ticker] || 0) - (livePrices[b.ticker] || 0); break;
        case "pnl": {
          const aPnl = livePrices[a.ticker] && a.costBasis ? ((livePrices[a.ticker]! - a.costBasis) / a.costBasis) : 0;
          const bPnl = livePrices[b.ticker] && b.costBasis ? ((livePrices[b.ticker]! - b.costBasis) / b.costBasis) : 0;
          cmp = aPnl - bPnl;
          break;
        }
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [stocks, query, sortKey, sortDir, livePrices]);

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " \u25B2" : " \u25BC") : "";

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
      {/* Header */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex items-center gap-4">
          <h3 className="text-2xl font-semibold">Stock Scoring</h3>
          {portfolioBeta != null && (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
              Portfolio &beta; {portfolioBeta.toFixed(2)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Refresh Prices */}
          <button
            onClick={fetchPrices}
            disabled={pricesLoading}
            className="flex items-center gap-1.5 rounded-xl bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-200 disabled:opacity-50 transition-colors"
            title="Refresh prices from Yahoo Finance"
          >
            <svg className={`w-3.5 h-3.5 ${pricesLoading ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
            {pricesLoading ? "Updating..." : "Refresh Prices"}
          </button>
          {/* Score All */}
          {onScoreStock && (
            <button
              onClick={handleScoreAll}
              disabled={scoringAll}
              className="flex items-center gap-1.5 rounded-xl bg-blue-600 px-4 py-2 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              title="Re-score all stocks with Claude"
            >
              {scoringAll ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" /></svg>
                  {scoreProgress}
                </>
              ) : (
                <>Score All ({stocks.length})</>
              )}
            </button>
          )}
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker, name, sector..."
            className="w-full min-w-[220px] rounded-xl border border-slate-200 bg-slate-50 px-4 py-2 text-sm outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all md:w-auto"
          />
        </div>
      </div>

      {pricesFetchedAt && (
        <p className="text-[10px] text-slate-400 mt-2">
          Prices updated {new Date(pricesFetchedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
        </p>
      )}

      {/* Split into Portfolio and Watchlist */}
      {(["Portfolio", "Watchlist"] as const).map((bucket) => {
        const bucketStocks = sorted.filter((s) => s.bucket === bucket);
        if (bucketStocks.length === 0) return null;
        const isPortfolio = bucket === "Portfolio";

        return (
          <div key={bucket} className="mt-6">
            {/* Section header */}
            <div className="flex items-center gap-3 mb-3">
              <h4 className={`text-sm font-bold uppercase tracking-wider ${isPortfolio ? "text-blue-600" : "text-slate-500"}`}>
                {bucket}
              </h4>
              <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${isPortfolio ? "bg-blue-50 text-blue-600" : "bg-slate-100 text-slate-500"}`}>
                {bucketStocks.length}
              </span>
              <div className={`flex-1 border-t ${isPortfolio ? "border-blue-200" : "border-slate-200"}`} />
            </div>

            {/* Mobile card view */}
            <div className="space-y-3 md:hidden">
              {bucketStocks.map((s) => {
                const livePrice = livePrices[s.ticker];
                const costBasis = s.costBasis;
                const pnlPct = livePrice && costBasis ? ((livePrice - costBasis) / costBasis * 100) : null;
                return (
                  <div
                    key={`mobile-${s.ticker}-${s.bucket}`}
                    className={`rounded-2xl border bg-white p-4 shadow-sm cursor-pointer hover:shadow-md transition-shadow ${isPortfolio ? "border-blue-100" : "border-slate-200"}`}
                    onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-lg font-bold text-slate-900">{s.ticker}</span>
                      <div className="flex items-center gap-1.5">
                        <SignalPill tone={ratingTone(s.rating)}>{s.rating}</SignalPill>
                        <SignalPill tone={riskTone(s.risk)}>{s.risk}</SignalPill>
                      </div>
                    </div>
                    <div className="text-xs text-slate-500 mb-3">{s.name} &middot; {s.sector}</div>
                    <div className="grid grid-cols-3 gap-3 text-center">
                      <div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider">Price</div>
                        <div className="text-sm font-semibold text-slate-800">
                          {pricesLoading ? "..." : livePrice != null ? `$${livePrice.toFixed(2)}` : "\u2014"}
                        </div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider">Score</div>
                        <div className="text-sm font-semibold text-slate-900">{s.adjusted}/{MAX_SCORE}</div>
                      </div>
                      <div>
                        <div className="text-[10px] text-slate-400 uppercase tracking-wider">P&L</div>
                        <div className={`text-sm font-semibold ${pnlPct != null ? (pnlPct >= 0 ? "text-emerald-600" : "text-red-500") : "text-slate-300"}`}>
                          {pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : "\u2014"}
                        </div>
                      </div>
                    </div>
                    {(s.companySummary || s.investmentThesis) && (
                      <div className="mt-3 pt-3 border-t border-slate-100 space-y-1">
                        {s.companySummary && <p className="text-[11px] text-slate-500 leading-relaxed">{s.companySummary}</p>}
                        {s.investmentThesis && <p className="text-[11px] text-blue-600 italic leading-relaxed">{s.investmentThesis}</p>}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="overflow-x-auto hidden md:block">
              <table className="w-full min-w-[1400px] text-left">
                <thead>
                  <tr className={`border-b text-xs text-slate-500 uppercase tracking-wider ${isPortfolio ? "border-blue-200" : "border-slate-200"}`}>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("ticker")}>Ticker{arrow("ticker")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("sector")}>Sector{arrow("sector")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none text-right" onClick={() => toggleSort("price")}>Price{arrow("price")}</th>
                    <th className="pb-3 pr-2 text-right">Cost Basis</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none text-right" onClick={() => toggleSort("pnl")}>P&L{arrow("pnl")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none text-right" onClick={() => toggleSort("raw")}>Raw{arrow("raw")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none text-right" onClick={() => toggleSort("adjusted")}>Adj.{arrow("adjusted")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("rating")}>Rating{arrow("rating")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("risk")}>Risk{arrow("risk")}</th>
                    <th className="pb-3 pr-2 cursor-pointer hover:text-slate-800 select-none text-right" onClick={() => toggleSort("effect")}>Regime{arrow("effect")}</th>
                    <th className="pb-3 pr-2">What They Do</th>
                    <th className="pb-3">Why Own It</th>
                  </tr>
                </thead>
                <tbody>
                  {bucketStocks.map((s) => {
                    const effect = (s.adjusted - s.raw).toFixed(1);
                    const livePrice = livePrices[s.ticker];
                    const cb = s.costBasis;
                    const pnlPct = livePrice && cb ? ((livePrice - cb) / cb * 100) : null;
                    return (
                      <tr
                        key={`${s.ticker}-${s.bucket}`}
                        className="border-b border-slate-100 align-top cursor-pointer hover:bg-slate-50/50 transition-colors"
                        onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}
                      >
                        <td className="py-3 pr-2">
                          <div className="font-semibold text-slate-900">{s.ticker}</div>
                          <div className="text-[11px] text-slate-400 truncate max-w-[120px]">{s.name}</div>
                        </td>
                        <td className="py-3 pr-2 text-xs text-slate-600">{s.sector}</td>
                        <td className="py-3 pr-2 text-right font-mono text-sm">
                          {pricesLoading ? (
                            <span className="text-slate-300 animate-pulse">...</span>
                          ) : livePrice != null ? (
                            <span className="font-semibold text-slate-800">${livePrice.toFixed(2)}</span>
                          ) : (
                            <span className="text-slate-300">&mdash;</span>
                          )}
                        </td>
                        <td className="py-3 pr-2 text-right" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="number"
                            step="0.01"
                            placeholder="—"
                            value={cb ?? ""}
                            onChange={(e) => {
                              const val = parseFloat(e.target.value);
                              if (onUpdateCostBasis && !isNaN(val)) onUpdateCostBasis(s.ticker, val);
                              else if (onUpdateCostBasis && e.target.value === "") onUpdateCostBasis(s.ticker, 0);
                            }}
                            className="w-20 rounded-lg border border-transparent bg-transparent px-1 py-0.5 text-right text-sm font-mono text-slate-600 hover:border-slate-200 focus:border-blue-300 focus:bg-white focus:outline-none focus:ring-1 focus:ring-blue-200 transition-all"
                          />
                        </td>
                        <td className="py-3 pr-2 text-right font-mono text-xs">
                          {pnlPct != null ? (
                            <span className={pnlPct >= 0 ? "text-emerald-600 font-semibold" : "text-red-500 font-semibold"}>
                              {pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%
                            </span>
                          ) : (
                            <span className="text-slate-300">&mdash;</span>
                          )}
                        </td>
                        <td className="py-3 pr-2 text-right text-sm text-slate-600">{s.raw}/{MAX_SCORE}</td>
                        <td className="py-3 pr-2 text-right text-sm font-semibold text-slate-900">{s.adjusted}/{MAX_SCORE}</td>
                        <td className="py-3 pr-2">
                          <SignalPill tone={ratingTone(s.rating)}>{s.rating}</SignalPill>
                        </td>
                        <td className="py-3 pr-2">
                          <SignalPill tone={riskTone(s.risk)}>{s.risk}</SignalPill>
                        </td>
                        <td className={`py-3 pr-2 text-right text-xs font-semibold ${Number(effect) >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                          {Number(effect) >= 0 ? "+" : ""}{effect}
                        </td>
                        <td className="max-w-[220px] py-3 pr-2 text-[11px] leading-relaxed text-slate-500">
                          {s.companySummary || <span className="text-slate-300 italic">Score to generate</span>}
                        </td>
                        <td className="max-w-[220px] py-3 text-[11px] leading-relaxed text-slate-500">
                          {s.investmentThesis || <span className="text-slate-300 italic">Score to generate</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </section>
  );
}
