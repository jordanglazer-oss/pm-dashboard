"use client";

import React, { useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, MAX_SCORE } from "@/app/lib/types";
import type { ScoreKey } from "@/app/lib/types";
import { groupTotal } from "@/app/lib/scoring";
import { SignalPill, ratingTone } from "@/app/components/SignalPill";
import StockHealthMonitor from "@/app/components/StockHealthMonitor";
import RiskAlertPanel from "@/app/components/RiskAlertPanel";
import StockChart from "@/app/components/StockChart";

// ── Color mapping ──
const GROUP_COLORS: Record<
  string,
  { bar: string; text: string; scoreText: string; activeBg: string; activeText: string; ring: string; barBg: string }
> = {
  blue:   { bar: "bg-blue-500",    text: "text-blue-600",    scoreText: "text-blue-600",    activeBg: "bg-blue-500",    activeText: "text-white", ring: "#3b82f6", barBg: "bg-blue-100" },
  purple: { bar: "bg-purple-500",  text: "text-purple-600",  scoreText: "text-purple-600",  activeBg: "bg-purple-500",  activeText: "text-white", ring: "#a855f7", barBg: "bg-purple-100" },
  teal:   { bar: "bg-teal-500",    text: "text-teal-600",    scoreText: "text-teal-600",    activeBg: "bg-teal-500",    activeText: "text-white", ring: "#14b8a6", barBg: "bg-teal-100" },
  green:  { bar: "bg-emerald-500", text: "text-emerald-600", scoreText: "text-emerald-600", activeBg: "bg-emerald-500", activeText: "text-white", ring: "#10b981", barBg: "bg-emerald-100" },
  amber:  { bar: "bg-amber-500",   text: "text-amber-600",   scoreText: "text-amber-600",   activeBg: "bg-amber-500",   activeText: "text-white", ring: "#f59e0b", barBg: "bg-amber-100" },
  red:    { bar: "bg-red-500",     text: "text-red-600",     scoreText: "text-red-600",     activeBg: "bg-red-500",     activeText: "text-white", ring: "#ef4444", barBg: "bg-red-100" },
};

const SECTORS = [
  "Technology", "Communication Services", "Consumer Discretionary", "Consumer Staples",
  "Energy", "Financials", "Health Care", "Industrials", "Materials", "Real Estate", "Utilities",
];

// Donut chart SVG
function ScoreDonut({ score, max, groups, stock }: { score: number; max: number; groups: typeof SCORE_GROUPS; stock: { scores: Record<string, number> } }) {
  const radius = 80;
  const strokeWidth = 16;
  const circumference = 2 * Math.PI * radius;
  const center = 100;
  const gap = 4; // degrees gap between segments

  const segments = groups.map((g) => ({
    color: GROUP_COLORS[g.color]?.ring || "#94a3b8",
    value: groupTotal(stock as never, g),
    maxVal: g.maxTotal,
  }));

  let offset = -90;

  // Rating label
  let ratingLabel = "Hold";
  if (score >= 30) ratingLabel = "Strong Buy";
  else if (score >= 26) ratingLabel = "Moderate Buy";
  else if (score >= 22) ratingLabel = "Hold";
  else if (score >= 18) ratingLabel = "Underweight";
  else ratingLabel = "Sell";

  const ratingColor = score >= 26 ? "#10b981" : score >= 22 ? "#f59e0b" : score >= 18 ? "#f97316" : "#ef4444";

  return (
    <div className="flex flex-col items-center">
      <svg viewBox="0 0 200 200" className="w-40 h-40">
        <circle cx={center} cy={center} r={radius} fill="none" stroke="#e2e8f0" strokeWidth={strokeWidth} />
        {segments.map((seg, i) => {
          const segPct = seg.value / max;
          const segDeg = segPct * 360;
          const segLen = segPct * circumference;
          const gapLen = (gap / 360) * circumference;
          const dashArray = `${Math.max(segLen - gapLen, 0)} ${circumference - Math.max(segLen - gapLen, 0)}`;
          const rotation = offset;
          offset += segDeg;
          if (seg.value === 0) return null;
          return (
            <circle
              key={i}
              cx={center}
              cy={center}
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth={strokeWidth}
              strokeDasharray={dashArray}
              strokeDashoffset={0}
              strokeLinecap="round"
              transform={`rotate(${rotation} ${center} ${center})`}
              className="transition-all duration-500"
            />
          );
        })}
        <text x={center} y={center - 4} textAnchor="middle" style={{ fontSize: "32px", fontWeight: 700 }} className="fill-slate-900">
          {score}
        </text>
        <text x={center} y={center + 16} textAnchor="middle" style={{ fontSize: "13px" }} className="fill-slate-400">
          / {max}
        </text>
      </svg>
      <span className="mt-1 text-sm font-bold" style={{ color: ratingColor }}>{ratingLabel}</span>
    </div>
  );
}

export default function StockDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ticker = (params.ticker as string)?.toUpperCase();
  const { getStock, scoredStocks, marketData, updateScore, updateExplanations, updateLastScored, updatePrice, updateSector, updateHealthData, updateTechnicals, updateStockFields, moveBucket, removeStock } = useStocks();
  const stock = getStock(ticker);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");

  if (!stock) {
    return (
      <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8">
        <div className="mx-auto max-w-5xl">
          <div className="rounded-[30px] border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-900">{ticker} not found</h1>
            <p className="mt-2 text-slate-500">This ticker is not in your portfolio or watchlist.</p>
            <Link href="/" className="mt-4 inline-block text-blue-600 hover:underline text-sm">Back to Dashboard</Link>
          </div>
        </div>
      </main>
    );
  }

  const portfolioTickers = scoredStocks.filter((s) => s.bucket === "Portfolio").map((s) => s.ticker);
  const watchlistTickers = scoredStocks.filter((s) => s.bucket === "Watchlist").map((s) => s.ticker);

  const handleRescore = async () => {
    setScoring(true);
    setScoreError("");
    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker: stock.ticker }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setScoreError(errData.error || `Scoring failed (${res.status})`);
        return;
      }
      const data = await res.json();
      if (data.scores) {
        for (const [key, val] of Object.entries(data.scores)) {
          updateScore(ticker, key as ScoreKey, val as number);
        }
      }
      if (data.explanations) {
        updateExplanations(ticker, data.explanations);
      }
      if (data.price != null) {
        updatePrice(ticker, data.price);
      }
      if (data.healthData) {
        updateHealthData(ticker, data.healthData);
      }
      if (data.technicals && data.riskAlert) {
        updateTechnicals(ticker, data.technicals, data.riskAlert);
      }
      if (data.companySummary || data.investmentThesis) {
        updateStockFields(ticker, {
          companySummary: data.companySummary || "",
          investmentThesis: data.investmentThesis || "",
        });
      }
      updateLastScored(ticker, new Date().toLocaleString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit", hour12: true,
      }));
    } catch (err) {
      setScoreError(err instanceof Error ? err.message : "Scoring failed");
    } finally {
      setScoring(false);
    }
  };

  const handleRefreshData = async () => {
    setRefreshing(true);
    setRefreshError("");
    try {
      const res = await fetch("/api/refresh-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: [stock.ticker] }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        setRefreshError(errData.error || `Refresh failed (${res.status})`);
        return;
      }
      const data = await res.json();
      const result = data.results?.[0];
      if (result) {
        if (result.price != null) updatePrice(ticker, result.price);
        if (result.healthData) updateHealthData(ticker, result.healthData);
        if (result.technicals && result.riskAlert) updateTechnicals(ticker, result.technicals, result.riskAlert);
      }
    } catch (err) {
      setRefreshError(err instanceof Error ? err.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  };

  const handleDelete = () => {
    removeStock(ticker);
    router.push("/");
  };

  return (
    <main className="min-h-screen bg-[#f4f5f7] text-slate-900 overflow-x-hidden">
      {/* Ticker navigation bar */}
      <div className="border-b border-slate-200 bg-white px-4 py-2.5 md:px-8 overflow-x-auto">
        <div className="flex items-center gap-2 w-max">
          <Link
            href="/"
            className="shrink-0 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors"
          >
            &larr; Dashboard
          </Link>
          {portfolioTickers.length > 0 && (
            <>
              <div className="h-5 w-px bg-slate-200 shrink-0" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Portfolio</span>
              {portfolioTickers.map((t) => (
                <Link
                  key={t}
                  href={`/stock/${t.toLowerCase()}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-mono transition-colors ${
                    t === ticker
                      ? "bg-blue-600 text-white"
                      : "border border-blue-200 text-blue-700 hover:bg-blue-50"
                  }`}
                >
                  {t}
                </Link>
              ))}
            </>
          )}
          {watchlistTickers.length > 0 && (
            <>
              <div className="h-5 w-px bg-slate-200 shrink-0" />
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wider text-slate-400">Watchlist</span>
              {watchlistTickers.map((t) => (
                <Link
                  key={t}
                  href={`/stock/${t.toLowerCase()}`}
                  className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-bold font-mono transition-colors ${
                    t === ticker
                      ? "bg-blue-600 text-white"
                      : "border border-slate-200 text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t}
                </Link>
              ))}
            </>
          )}
        </div>
      </div>

      <div className="px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-7xl">
          {/* Stock header card */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_200px] gap-6 items-start">
              {/* Left: stock info */}
              <div className="min-w-0">
                {/* Ticker + price */}
                <div className="flex items-baseline gap-2 sm:gap-3 flex-wrap mb-1">
                  <h1 className="text-2xl sm:text-3xl font-bold font-mono tracking-tight">{stock.ticker}</h1>
                  {stock.price != null && (
                    <span className="text-xl sm:text-2xl font-semibold text-slate-600">${stock.price.toFixed(2)}</span>
                  )}
                  <SignalPill tone={stock.bucket === "Portfolio" ? "blue" : "gray"}>
                    {stock.bucket}
                  </SignalPill>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap mb-3">
                  <button
                    onClick={handleRescore}
                    disabled={scoring}
                    className="rounded-lg bg-blue-600 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                  >
                    {scoring ? "Scoring..." : "Score"}
                  </button>
                  <button
                    onClick={handleRefreshData}
                    disabled={refreshing}
                    className="rounded-lg bg-emerald-600 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-emerald-700 transition-colors disabled:opacity-50"
                  >
                    {refreshing ? "Refreshing..." : "Refresh Data"}
                  </button>
                  <button
                    onClick={() => moveBucket(ticker)}
                    className="rounded-lg border border-slate-300 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-medium text-slate-600 hover:bg-slate-50 transition-colors"
                  >
                    Move to {stock.bucket === "Portfolio" ? "Watchlist" : "Portfolio"}
                  </button>
                  <button
                    onClick={handleDelete}
                    className="rounded-lg border border-red-200 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-red-600 hover:bg-red-50 transition-colors"
                  >
                    Delete
                  </button>
                  {stock.lastScored && (
                    <span className="text-xs text-slate-400 ml-1">
                      Last scored: {stock.lastScored}
                    </span>
                  )}
                  {scoreError && <span className="text-xs text-red-500 ml-1">{scoreError}</span>}
                  {refreshError && <span className="text-xs text-red-500 ml-1">{refreshError}</span>}
                </div>

                {/* Sector selector */}
                <div className="flex items-center gap-3 mb-2">
                  <select
                    value={stock.sector}
                    onChange={(e) => updateSector(ticker, e.target.value)}
                    className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {SECTORS.map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* Company name */}
                <p className="text-base text-slate-600">{stock.name}</p>

                {/* Company summary & investment thesis */}
                {stock.companySummary && (
                  <p className="mt-2 text-sm text-slate-500 leading-relaxed">{stock.companySummary}</p>
                )}
                {stock.investmentThesis && (
                  <p className="mt-1 text-sm italic text-blue-600/70 leading-relaxed">{stock.investmentThesis}</p>
                )}

                {/* Group progress bars */}
                <div className="mt-6 space-y-3 max-w-xl">
                  {SCORE_GROUPS.map((group) => {
                    const total = groupTotal(stock, group);
                    const colors = GROUP_COLORS[group.color] || GROUP_COLORS.blue;
                    const pct = (total / group.maxTotal) * 100;

                    return (
                      <div key={group.name} className="flex items-center gap-3">
                        <span className="w-20 text-right text-xs text-slate-500 shrink-0 leading-tight">
                          {group.name === "Company Specific" ? "Company Specific" : group.name}
                        </span>
                        <div className="flex-1 h-3.5 rounded-full bg-slate-100 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${colors.bar} transition-all duration-500`}
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <span className={`w-10 text-right text-xs font-bold shrink-0 ${colors.scoreText}`}>
                          {total}/{group.maxTotal}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Right: donut chart */}
              <div className="flex justify-center lg:justify-end">
                <ScoreDonut score={stock.adjusted} max={MAX_SCORE} groups={SCORE_GROUPS} stock={stock} />
              </div>
            </div>
          </div>

          {/* Price Chart */}
          <StockChart ticker={stock.ticker} technicals={stock.technicals} className="mt-6" />

          {/* Score breakdown - 2 column grid */}
          <div className="grid gap-4 md:grid-cols-2 mt-6">
            {SCORE_GROUPS.map((group) => {
              const total = groupTotal(stock, group);
              const colors = GROUP_COLORS[group.color] || GROUP_COLORS.blue;
              const pct = (total / group.maxTotal) * 100;

              return (
                <div key={group.name} className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className={`text-base ${colors.text}`}>{group.icon}</span>
                      <h2 className="text-base font-bold text-slate-800">{group.name}</h2>
                    </div>
                    <div className="flex items-baseline gap-0.5">
                      <span className={`text-2xl font-bold ${colors.scoreText}`}>{total}</span>
                      <span className="text-sm text-slate-400">/{group.maxTotal}</span>
                    </div>
                  </div>

                  <div className="h-1.5 rounded-full bg-slate-100 mb-5 overflow-hidden">
                    <div className={`h-full rounded-full ${colors.bar} transition-all`} style={{ width: `${pct}%` }} />
                  </div>

                  <div className="space-y-4">
                    {group.categories.map((cat) => {
                      const val = stock.scores[cat.key as ScoreKey] || 0;
                      const bullets = stock.explanations?.[cat.key as ScoreKey];
                      const typeBg =
                        cat.inputType === "auto"
                          ? "bg-emerald-100 text-emerald-700"
                          : cat.inputType === "semi"
                          ? "bg-blue-100 text-blue-700"
                          : "bg-slate-100 text-slate-600";

                      return (
                        <div key={cat.key}>
                          <div className="flex items-center justify-between mb-2">
                            <div className="flex items-center gap-2">
                              <span className="text-sm text-slate-700">{cat.label}</span>
                              <span className="text-xs text-slate-400">/{cat.max}</span>
                              <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${typeBg}`}>
                                {cat.inputType.toUpperCase()}
                              </span>
                            </div>
                            <div className="flex gap-1">
                              {Array.from({ length: cat.max + 1 }, (_, i) => (
                                <button
                                  key={i}
                                  onClick={() => updateScore(ticker, cat.key as ScoreKey, i)}
                                  className={`flex h-7 w-7 items-center justify-center rounded-md text-xs font-semibold transition-colors cursor-pointer hover:opacity-80 ${
                                    i === val
                                      ? `${colors.activeBg} ${colors.activeText}`
                                      : "bg-slate-100 text-slate-400 hover:bg-slate-200"
                                  }`}
                                >
                                  {i}
                                </button>
                              ))}
                            </div>
                          </div>
                          {bullets && bullets.length > 0 && (
                            <ul className="ml-1 space-y-1 mb-1">
                              {bullets.map((b, i) => (
                                <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-500">
                                  <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-300" />
                                  {b}
                                </li>
                              ))}
                            </ul>
                          )}
                          {!bullets && cat.inputType !== "manual" && (
                            <p className="text-[11px] text-slate-400 italic ml-1">Re-score via Claude to generate explanation</p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Regime context */}
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm mt-6">
            <h2 className="text-base font-bold text-slate-800 mb-3">Regime Context</h2>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Current Regime</div>
                <div className="mt-1 text-lg font-semibold">{marketData.riskRegime}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Sector Classification</div>
                <div className="mt-1 text-lg font-semibold">
                  {["Technology", "Communication Services", "Consumer Discretionary"].includes(stock.sector)
                    ? "Offensive"
                    : ["Energy", "Utilities", "Consumer Staples", "Financials", "Materials", "Industrials"].includes(stock.sector)
                    ? "Defensive"
                    : "Neutral"}
                </div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Regime Effect</div>
                <div className={`mt-1 text-lg font-semibold ${stock.adjusted - stock.raw >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {stock.adjusted - stock.raw >= 0 ? "+" : ""}{(stock.adjusted - stock.raw).toFixed(1)} pts
                </div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">Composite Signal</div>
                <div className="mt-1 text-lg font-semibold">{marketData.compositeSignal}</div>
              </div>
            </div>
          </div>

          {/* Risk Alert Panel */}
          {stock.riskAlert && stock.technicals && (
            <RiskAlertPanel riskAlert={stock.riskAlert} technicals={stock.technicals} />
          )}

          {/* Stock Health Monitor */}
          {stock.healthData && <StockHealthMonitor healthData={stock.healthData} />}
        </div>
      </div>
    </main>
  );
}
