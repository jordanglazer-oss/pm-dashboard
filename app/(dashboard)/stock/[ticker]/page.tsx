"use client";

import React, { useState, useEffect, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import { SCORE_GROUPS, MAX_SCORE, INSTRUMENT_LABELS } from "@/app/lib/types";
import type { ScoreKey, FundData } from "@/app/lib/types";
import { groupTotal, isScoreable } from "@/app/lib/scoring";
import { SignalPill, ratingTone } from "@/app/components/SignalPill";
import StockHealthMonitor from "@/app/components/StockHealthMonitor";
import RiskAlertPanel from "@/app/components/RiskAlertPanel";
import StockChart from "@/app/components/StockChart";

// ── Helpers ──
function formatAUM(value: number): string {
  if (value >= 1e12) return `$${(value / 1e12).toFixed(1)}T`;
  if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `$${(value / 1e6).toFixed(0)}M`;
  return `$${value.toLocaleString()}`;
}

function formatReturn(value: number | undefined): string {
  if (value == null) return "--";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

function returnColor(value: number | undefined): string {
  if (value == null) return "text-slate-400";
  return value >= 0 ? "text-emerald-600" : "text-red-500";
}

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

// ── Fund Data Panels ──
function FundDataPanels({ fundData, ticker, onHoldingsUpdate }: { fundData: FundData; ticker: string; onHoldingsUpdate?: (holdings: FundData["topHoldings"], sectors: FundData["sectorWeightings"], url: string) => void }) {
  const [holdingsUrl, setHoldingsUrl] = useState(fundData.holdingsUrl || "");
  const [scrapingHoldings, setScrapingHoldings] = useState(false);
  const [scrapeError, setScrapeError] = useState("");
  const [scrapeSuccess, setScrapeSuccess] = useState(false);

  const handleScrapeHoldings = async () => {
    if (!holdingsUrl.trim()) return;
    setScrapingHoldings(true);
    setScrapeError("");
    setScrapeSuccess(false);
    try {
      const res = await fetch("/api/fund-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: holdingsUrl.trim(), ticker }),
      });
      const data = await res.json();
      if (!res.ok) {
        setScrapeError(data.error || "Failed to scrape holdings");
        return;
      }
      if (data.topHoldings?.length) {
        onHoldingsUpdate?.(data.topHoldings, data.sectorWeightings, holdingsUrl.trim());
        setScrapeSuccess(true);
        setTimeout(() => setScrapeSuccess(false), 3000);
      }
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setScrapingHoldings(false);
    }
  };
  const sectorColors: Record<string, string> = {
    Technology: "bg-blue-500",
    Financials: "bg-teal-500",
    "Health Care": "bg-purple-500",
    "Consumer Discretionary": "bg-orange-500",
    "Consumer Staples": "bg-amber-500",
    "Communication Services": "bg-indigo-500",
    Industrials: "bg-slate-500",
    Energy: "bg-red-500",
    Utilities: "bg-lime-500",
    Materials: "bg-cyan-500",
    "Real Estate": "bg-pink-500",
  };

  return (
    <div className="space-y-4 mt-6">
      {/* Row 1: Performance + Risk */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Performance */}
        {fundData.performance && (
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-bold text-slate-800 mb-4">Performance</h2>
            <div className="grid grid-cols-4 gap-2 text-center">
              {[
                { label: "1M", val: fundData.performance.oneMonth },
                { label: "3M", val: fundData.performance.threeMonth },
                { label: "YTD", val: fundData.performance.ytd },
                { label: "1Y", val: fundData.performance.oneYear },
                { label: "3Y", val: fundData.performance.threeYear },
                { label: "5Y", val: fundData.performance.fiveYear },
                { label: "10Y", val: fundData.performance.tenYear },
              ]
                .filter((r) => r.val != null)
                .map((r) => (
                  <div key={r.label} className="rounded-xl bg-slate-50 p-2.5">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase">{r.label}</div>
                    <div className={`mt-1 text-sm font-bold ${returnColor(r.val)}`}>
                      {formatReturn(r.val)}
                    </div>
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Risk & Key Stats */}
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-slate-800 mb-4">Key Statistics</h2>
          <div className="grid grid-cols-2 gap-3">
            {fundData.fundFamily && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Fund Family</div>
                <div className="mt-1 text-sm font-semibold text-slate-700 truncate">{fundData.fundFamily}</div>
              </div>
            )}
            {fundData.inceptionDate && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Inception</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.inceptionDate}</div>
              </div>
            )}
            {fundData.turnover != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Turnover</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.turnover.toFixed(0)}%</div>
              </div>
            )}
            {fundData.riskStats?.beta != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Beta (3Y)</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.beta.toFixed(2)}</div>
              </div>
            )}
            {fundData.riskStats?.sharpeRatio != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Sharpe (3Y)</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.sharpeRatio.toFixed(2)}</div>
              </div>
            )}
            {fundData.riskStats?.stdDev != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Std Dev (3Y)</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.stdDev.toFixed(2)}%</div>
              </div>
            )}
            {fundData.riskStats?.alpha != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">Alpha (3Y)</div>
                <div className={`mt-1 text-sm font-semibold ${fundData.riskStats.alpha >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                  {fundData.riskStats.alpha >= 0 ? "+" : ""}{fundData.riskStats.alpha.toFixed(2)}
                </div>
              </div>
            )}
            {fundData.riskStats?.rSquared != null && (
              <div className="rounded-xl bg-slate-50 p-2.5">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">R-Squared</div>
                <div className="mt-1 text-sm font-semibold text-slate-700">{fundData.riskStats.rSquared.toFixed(2)}</div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: Top Holdings + Sector Breakdown */}
      <div className="grid gap-4 md:grid-cols-2">
        {/* Top Holdings */}
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-slate-800 mb-3">Top Holdings</h2>
          {fundData.topHoldings && fundData.topHoldings.length > 0 ? (
            <div className="space-y-1.5">
              {fundData.topHoldings.map((h, i) => (
                <div key={i} className="flex items-center gap-3">
                  <span className="w-5 text-xs text-slate-400 text-right">{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      {h.symbol && <span className="text-xs font-bold font-mono text-slate-700">{h.symbol}</span>}
                      <span className="text-xs text-slate-500 truncate">{h.name}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <div className="w-20 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-blue-500"
                        style={{ width: `${Math.min(h.weight * 3, 100)}%` }}
                      />
                    </div>
                    <span className="w-12 text-right text-xs font-semibold text-slate-700">{h.weight.toFixed(1)}%</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* Missing holdings alert */
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mb-3">
              <div className="flex items-start gap-2">
                <svg className="w-4 h-4 text-amber-500 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 6a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 6zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" /></svg>
                <div>
                  <p className="text-xs font-semibold text-amber-800">Holdings data not available</p>
                  <p className="text-[11px] text-amber-700 mt-0.5">
                    Automatic sources could not find holdings for this fund. Paste a link to the fund&apos;s holdings page below.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Custom URL input — always shown to allow refresh from provider */}
          {onHoldingsUpdate && (
            <div className="mt-3 pt-3 border-t border-slate-100">
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                Holdings source URL
              </label>
              <div className="flex gap-2 mt-1">
                <input
                  type="url"
                  value={holdingsUrl}
                  onChange={(e) => { setHoldingsUrl(e.target.value); setScrapeError(""); }}
                  placeholder="https://provider.com/etf/holdings"
                  className="flex-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs outline-none placeholder:text-slate-400 focus:bg-white focus:border-blue-300 focus:ring-1 focus:ring-blue-200 transition-all"
                />
                <button
                  onClick={handleScrapeHoldings}
                  disabled={scrapingHoldings || !holdingsUrl.trim()}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50 transition-colors whitespace-nowrap"
                >
                  {scrapingHoldings ? "Loading..." : "Fetch"}
                </button>
              </div>
              {scrapeError && (
                <p className="text-[11px] text-red-500 mt-1">{scrapeError}</p>
              )}
              {scrapeSuccess && (
                <p className="text-[11px] text-emerald-600 mt-1">Holdings updated successfully!</p>
              )}
            </div>
          )}
        </div>

        {/* Sector Breakdown */}
        {fundData.sectorWeightings && fundData.sectorWeightings.length > 0 && (
          <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-base font-bold text-slate-800 mb-3">Sector Breakdown</h2>
            {/* Stacked bar */}
            <div className="flex h-8 rounded-xl overflow-hidden mb-3">
              {fundData.sectorWeightings.map((s) => (
                <div
                  key={s.sector}
                  className={`${sectorColors[s.sector] || "bg-slate-400"} flex items-center justify-center text-[10px] font-semibold text-white`}
                  style={{ width: `${s.weight}%` }}
                >
                  {s.weight >= 8 && `${s.weight.toFixed(0)}%`}
                </div>
              ))}
            </div>
            <div className="space-y-1.5">
              {fundData.sectorWeightings.map((s) => (
                <div key={s.sector} className="flex items-center gap-2">
                  <span className={`h-2.5 w-2.5 rounded-full shrink-0 ${sectorColors[s.sector] || "bg-slate-400"}`} />
                  <span className="flex-1 text-xs text-slate-600">{s.sector}</span>
                  <span className="text-xs font-semibold text-slate-700">{s.weight.toFixed(1)}%</span>
                </div>
              ))}
            </div>

            {/* Asset Allocation */}
            {fundData.assetAllocation && (
              <div className="mt-4 pt-3 border-t border-slate-100">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">Asset Allocation</div>
                <div className="grid grid-cols-4 gap-2 text-center">
                  {fundData.assetAllocation.stock != null && (
                    <div className="rounded-lg bg-blue-50 p-2">
                      <div className="text-[10px] text-blue-500">Stocks</div>
                      <div className="text-sm font-bold text-blue-700">{fundData.assetAllocation.stock.toFixed(1)}%</div>
                    </div>
                  )}
                  {fundData.assetAllocation.bond != null && (
                    <div className="rounded-lg bg-amber-50 p-2">
                      <div className="text-[10px] text-amber-500">Bonds</div>
                      <div className="text-sm font-bold text-amber-700">{fundData.assetAllocation.bond.toFixed(1)}%</div>
                    </div>
                  )}
                  {fundData.assetAllocation.cash != null && (
                    <div className="rounded-lg bg-emerald-50 p-2">
                      <div className="text-[10px] text-emerald-500">Cash</div>
                      <div className="text-sm font-bold text-emerald-700">{fundData.assetAllocation.cash.toFixed(1)}%</div>
                    </div>
                  )}
                  {fundData.assetAllocation.other != null && (
                    <div className="rounded-lg bg-slate-50 p-2">
                      <div className="text-[10px] text-slate-500">Other</div>
                      <div className="text-sm font-bold text-slate-700">{fundData.assetAllocation.other.toFixed(1)}%</div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Row 3: Equity Metrics (P/E, P/B, etc.) */}
      {fundData.equityMetrics && (
        <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-base font-bold text-slate-800 mb-3">Underlying Equity Metrics</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {fundData.equityMetrics.priceToEarnings != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/E Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToEarnings.toFixed(1)}</div>
              </div>
            )}
            {fundData.equityMetrics.priceToBook != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/B Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToBook.toFixed(2)}</div>
              </div>
            )}
            {fundData.equityMetrics.priceToSales != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/S Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToSales.toFixed(2)}</div>
              </div>
            )}
            {fundData.equityMetrics.priceToCashflow != null && (
              <div className="rounded-xl bg-slate-50 p-3 text-center">
                <div className="text-[10px] font-semibold text-slate-400 uppercase">P/CF Ratio</div>
                <div className="mt-1 text-xl font-bold text-slate-800">{fundData.equityMetrics.priceToCashflow.toFixed(2)}</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function StockDetailPage() {
  const params = useParams();
  const router = useRouter();
  const ticker = (params.ticker as string)?.toUpperCase();
  const { getStock, scoredStocks, marketData, updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields, updateWeight, updateFundData, moveBucket, removeStock } = useStocks();
  const stock = getStock(ticker);
  const [scoring, setScoring] = useState(false);
  const [scoreError, setScoreError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState("");
  const [editingWeight, setEditingWeight] = useState(false);
  const [weightInput, setWeightInput] = useState("");
  const [loadingFundData, setLoadingFundData] = useState(false);

  const scoreable = stock ? isScoreable(stock) : true;

  const fetchFundData = useCallback(async () => {
    if (!stock || scoreable) return;
    setLoadingFundData(true);
    try {
      const res = await fetch(`/api/fund-data?ticker=${encodeURIComponent(ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.fundData) updateFundData(ticker, data.fundData);
        // Update name from Morningstar for Canadian funds if we got a better name
        if (data.name && (!stock.name || stock.name === ticker)) {
          updateStockFields(ticker, { name: data.name });
        }
      }
    } catch { /* best effort */ }
    finally { setLoadingFundData(false); }
  }, [ticker, stock, scoreable, updateFundData, updateStockFields]);

  // Auto-fetch fund data on mount if missing
  useEffect(() => {
    if (stock && !scoreable && !stock.fundData) {
      fetchFundData();
    }
  }, [stock, scoreable, fetchFundData]);

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
      if (data.companySummary || data.investmentThesis || data.sector || data.name) {
        updateStockFields(ticker, {
          ...(data.companySummary ? { companySummary: data.companySummary } : {}),
          ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
          ...(data.sector ? { sector: data.sector } : {}),
          ...(data.name && data.name !== "Unknown" ? { name: data.name } : {}),
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
        if (result.name || result.sector) {
          updateStockFields(ticker, {
            ...(result.name ? { name: result.name } : {}),
            ...(result.sector ? { sector: result.sector } : {}),
          });
        }
      }
      // Also refresh fund data for ETFs/mutual funds
      if (!scoreable) {
        await fetchFundData();
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
                  {stock.instrumentType && stock.instrumentType !== "stock" && (
                    <span className={`rounded-md px-2 py-0.5 text-xs font-bold ${stock.instrumentType === "etf" ? "bg-indigo-100 text-indigo-700" : "bg-purple-100 text-purple-700"}`}>
                      {INSTRUMENT_LABELS[stock.instrumentType]}
                    </span>
                  )}
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap mb-3">
                  {scoreable && (
                    <button
                      onClick={handleRescore}
                      disabled={scoring}
                      className="rounded-lg bg-blue-600 px-3 sm:px-4 py-1.5 text-xs sm:text-sm font-semibold text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
                    >
                      {scoring ? "Scoring..." : "Score"}
                    </button>
                  )}
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

                {/* Sector (stocks only) + Weight (funds only) */}
                <div className="flex items-center gap-2 mb-2">
                  {scoreable && stock.sector && (
                    <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700">{stock.sector}</span>
                  )}
                  {!scoreable && (
                    <div className="flex items-center gap-1.5">
                      <span className="text-xs text-slate-400">Weight:</span>
                      {editingWeight ? (
                        <form
                          onSubmit={(e) => {
                            e.preventDefault();
                            const val = parseFloat(weightInput);
                            if (!isNaN(val) && val >= 0) {
                              updateWeight(ticker, val);
                            }
                            setEditingWeight(false);
                          }}
                          className="flex items-center gap-1"
                        >
                          <input
                            value={weightInput}
                            onChange={(e) => setWeightInput(e.target.value)}
                            type="number"
                            step="0.1"
                            min="0"
                            autoFocus
                            className="w-16 rounded-md border border-slate-300 px-2 py-1 text-sm outline-none focus:border-blue-400"
                          />
                          <span className="text-xs text-slate-400">%</span>
                          <button type="submit" className="rounded-md bg-blue-600 px-2 py-1 text-xs font-semibold text-white hover:bg-blue-700">Save</button>
                          <button type="button" onClick={() => setEditingWeight(false)} className="text-xs text-slate-400 hover:text-slate-600">Cancel</button>
                        </form>
                      ) : (
                        <button
                          onClick={() => { setWeightInput(String(stock.weights.portfolio)); setEditingWeight(true); }}
                          className="rounded-md bg-slate-100 px-2 py-1 text-sm font-semibold text-slate-700 hover:bg-slate-200 transition-colors"
                        >
                          {stock.weights.portfolio}%
                        </button>
                      )}
                    </div>
                  )}
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

                {/* Group progress bars (stocks only) */}
                {scoreable && (
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
                )}

                {/* Fund key stats for non-scoreable instruments */}
                {!scoreable && (
                  <div className="mt-6 max-w-xl">
                    {loadingFundData && !stock.fundData && (
                      <div className="rounded-xl bg-slate-50 p-4">
                        <p className="text-sm text-slate-400 animate-pulse">Loading fund data...</p>
                      </div>
                    )}
                    {stock.fundData && (
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {stock.fundData.expenseRatio != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                              {stock.instrumentType === "mutual-fund" ? "MER" : "Expense Ratio"}
                            </div>
                            <div className="mt-1 text-lg font-bold text-slate-800">{stock.fundData.expenseRatio.toFixed(2)}%</div>
                          </div>
                        )}
                        {stock.fundData.totalAssets != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">AUM</div>
                            <div className="mt-1 text-lg font-bold text-slate-800">{formatAUM(stock.fundData.totalAssets)}</div>
                          </div>
                        )}
                        {stock.fundData.yield != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Yield</div>
                            <div className="mt-1 text-lg font-bold text-slate-800">{stock.fundData.yield.toFixed(2)}%</div>
                          </div>
                        )}
                        {stock.fundData.starRating != null && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Morningstar</div>
                            <div className="mt-1 text-lg font-bold text-amber-500">
                              {"★".repeat(stock.fundData.starRating)}{"☆".repeat(5 - stock.fundData.starRating)}
                            </div>
                          </div>
                        )}
                        {stock.fundData.category && (
                          <div className="rounded-xl bg-slate-50 p-3">
                            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">Category</div>
                            <div className="mt-1 text-sm font-bold text-slate-800 leading-tight">{stock.fundData.category}</div>
                          </div>
                        )}
                      </div>
                    )}
                    {!stock.fundData && !loadingFundData && (
                      <button
                        onClick={fetchFundData}
                        className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 transition-colors"
                      >
                        Load Fund Data
                      </button>
                    )}
                  </div>
                )}
              </div>

              {/* Right: donut chart (stocks only) */}
              {scoreable && (
                <div className="flex justify-center lg:justify-end">
                  <ScoreDonut score={stock.adjusted} max={MAX_SCORE} groups={SCORE_GROUPS} stock={stock} />
                </div>
              )}
            </div>
          </div>

          {/* Price Chart (not available for mutual funds) */}
          {stock.instrumentType !== "mutual-fund" && (
            <StockChart ticker={stock.ticker} technicals={stock.technicals} className="mt-6" />
          )}

          {/* Fund Data Panels (ETFs / Mutual Funds) */}
          {!scoreable && stock.fundData && (
            <FundDataPanels
              fundData={stock.fundData}
              ticker={stock.ticker}
              onHoldingsUpdate={(holdings, sectors, url) => {
                updateFundData(stock.ticker, {
                  ...stock.fundData!,
                  topHoldings: holdings,
                  sectorWeightings: sectors,
                  holdingsUrl: url,
                });
              }}
            />
          )}

          {/* Score breakdown - 2 column grid (stocks only) */}
          {scoreable && <div className="grid gap-4 md:grid-cols-2 mt-6">
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
          </div>}

          {/* Regime context (stocks only) */}
          {scoreable && <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm mt-6">
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
          </div>}

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
