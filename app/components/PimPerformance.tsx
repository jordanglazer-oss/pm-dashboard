"use client";

import React, { useState, useEffect, useMemo, useCallback } from "react";
import type { PimPerformanceData, PimModelPerformance, PimProfileType } from "@/app/lib/pim-types";
import { useStocks } from "@/app/lib/StockContext";
import { allEquityDailyValueSeed } from "@/app/lib/pim-daily-value-seed";

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
};

const PERIOD_OPTIONS = [
  { label: "1M", days: 21 },
  { label: "3M", days: 63 },
  { label: "6M", days: 126 },
  { label: "YTD", days: -1 },
  { label: "1Y", days: 252 },
  { label: "3Y", days: 756 },
  { label: "5Y", days: 1260 },
  { label: "All", days: 0 },
];

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtDate(d: string): string {
  const date = new Date(d + "T12:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDateFull(d: string): string {
  const date = new Date(d + "T12:00:00");
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

type Props = {
  groupId: string;
  groupName: string;
};

export function PimPerformance({ groupId, groupName }: Props) {
  const { getGroupState } = useStocks();
  const groupState = getGroupState(groupId);
  const trackingStart = groupState?.trackingStart;

  const [perfData, setPerfData] = useState<PimPerformanceData | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState<PimProfileType>("allEquity");
  const [period, setPeriod] = useState("All");
  const [autoUpdating, setAutoUpdating] = useState(false);
  const [seeded, setSeeded] = useState(false);

  // Load cached performance data, auto-seed if empty
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch("/api/kv/pim-performance");
        if (res.ok) {
          const data = await res.json();
          if (data.models?.length > 0) {
            setPerfData(data);
          } else {
            // No data — auto-seed from hardcoded historical values
            seedHistoricalData();
          }
        } else {
          seedHistoricalData();
        }
      } catch {
        seedHistoricalData();
      }
    }
    load();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Refresh = append new daily values only (never recompute historical data)
  const refreshPerformance = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/update-daily-value", { method: "POST" });
      if (res.ok) {
        // Reload cached data
        const perfRes = await fetch("/api/kv/pim-performance");
        if (perfRes.ok) {
          const data = await perfRes.json();
          if (data.models?.length > 0) setPerfData(data);
        }
      }
    } catch { /* ignore */ }
    setRefreshing(false);
  }, []);

  // Auto-seed: if no performance data for this group, seed from hardcoded historical data
  const seedHistoricalData = useCallback(async () => {
    if (seeded) return;
    setSeeded(true);
    try {
      // Seed allEquity profile with hardcoded daily values
      const seedData: PimPerformanceData = {
        models: [{
          groupId,
          profile: "allEquity",
          history: allEquityDailyValueSeed,
          lastUpdated: new Date().toISOString(),
        }],
        lastUpdated: new Date().toISOString(),
      };
      await fetch("/api/kv/pim-performance", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(seedData),
      });
      setPerfData(seedData);

      // Also set tracking start in portfolio state
      await fetch("/api/kv/pim-portfolio-state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          groupStates: [{
            groupId,
            trackingStart: { date: allEquityDailyValueSeed[0].date, prices: {} },
            lastRebalance: null,
            transactions: [],
          }],
          lastUpdated: new Date().toISOString(),
        }),
      });
    } catch { /* ignore */ }
  }, [groupId, seeded]);

  // Auto-update: append today's daily value using live prices
  const autoUpdateDailyValue = useCallback(async () => {
    setAutoUpdating(true);
    try {
      const res = await fetch("/api/update-daily-value", { method: "POST" });
      if (res.ok) {
        const result = await res.json();
        if (result.updates?.length > 0) {
          // Reload performance data
          const perfRes = await fetch("/api/kv/pim-performance");
          if (perfRes.ok) {
            const data = await perfRes.json();
            if (data.models?.length > 0) setPerfData(data);
          }
        }
      }
    } catch { /* ignore */ }
    setAutoUpdating(false);
  }, []);

  // Auto-update daily values when data is loaded and stale
  useEffect(() => {
    if (!perfData || perfData.models.length === 0 || autoUpdating) return;
    const groupModels = perfData.models.filter((m) => m.groupId === groupId);
    if (groupModels.length === 0) return;

    // Check if any model's last date is before today
    const today = new Date().toISOString().split("T")[0];
    const needsUpdate = groupModels.some((m) => {
      if (m.history.length < 2) return false;
      const lastDate = m.history[m.history.length - 1].date;
      return lastDate < today;
    });

    // Also check it's a weekday (markets open)
    const dayOfWeek = new Date().getDay();
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

    if (needsUpdate && isWeekday) {
      autoUpdateDailyValue();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [perfData?.lastUpdated, groupId]);

  // Get models for selected group
  const groupModels = useMemo(() => {
    if (!perfData) return [];
    return perfData.models.filter((m) => m.groupId === groupId);
  }, [perfData, groupId]);

  const selectedModel = useMemo(() => {
    return groupModels.find((m) => m.profile === selectedProfile) || groupModels[0];
  }, [groupModels, selectedProfile]);

  // Filter history by period
  const filteredHistory = useMemo(() => {
    if (!selectedModel) return [];
    const hist = selectedModel.history;
    if (hist.length === 0) return [];

    const periodOpt = PERIOD_OPTIONS.find((p) => p.label === period);
    if (!periodOpt) return hist;

    if (periodOpt.days === 0) return hist;

    if (periodOpt.days === -1) {
      const year = new Date().getFullYear();
      const ytdStart = `${year}-01-01`;
      return hist.filter((h) => h.date >= ytdStart);
    }

    return hist.slice(-periodOpt.days);
  }, [selectedModel, period]);

  // Compute summary stats
  const stats = useMemo(() => {
    if (filteredHistory.length < 2) return null;
    const first = filteredHistory[0];
    const last = filteredHistory[filteredHistory.length - 1];
    const totalReturn = ((last.value - first.value) / first.value) * 100;
    const dailyReturns = filteredHistory.slice(1).map((h) => h.dailyReturn);
    if (dailyReturns.length === 0) return null;
    const avg = dailyReturns.reduce((s, r) => s + r, 0) / dailyReturns.length;
    const maxDay = Math.max(...dailyReturns);
    const minDay = Math.min(...dailyReturns);
    const variance = dailyReturns.reduce((s, r) => s + (r - avg) ** 2, 0) / dailyReturns.length;
    const dailyVol = Math.sqrt(variance);
    const annualizedVol = dailyVol * Math.sqrt(252);

    // Annualized return (CAGR)
    const days = filteredHistory.length;
    const years = days / 252;
    const annualizedReturn = years > 1 ? (Math.pow(last.value / first.value, 1 / years) - 1) * 100 : null;

    return {
      totalReturn,
      annualizedReturn,
      avgDaily: avg,
      maxDay,
      minDay,
      annualizedVol,
      lastValue: last.value,
      lastDate: last.date,
      lastDailyReturn: last.dailyReturn,
      days,
    };
  }, [filteredHistory]);

  // Calendar year returns
  const calendarYearReturns = useMemo(() => {
    if (!selectedModel || selectedModel.history.length < 2) return [];
    const hist = selectedModel.history;
    const years: Map<number, { first: number; last: number }> = new Map();

    for (const h of hist) {
      const y = parseInt(h.date.substring(0, 4));
      const entry = years.get(y);
      if (!entry) {
        years.set(y, { first: h.value, last: h.value });
      } else {
        entry.last = h.value;
      }
    }

    const results: Array<{ year: number; return: number }> = [];
    for (const [y, v] of years) {
      results.push({ year: y, return: ((v.last - v.first) / v.first) * 100 });
    }
    // For years after the first year, the return should be calculated from
    // the previous year's last value (which is the starting value for the new year)
    // Actually, let's recalculate properly: year-start to year-end
    const sorted = [...years.entries()].sort((a, b) => a[0] - b[0]);
    const proper: Array<{ year: number; return: number }> = [];
    for (let i = 0; i < sorted.length; i++) {
      const [y] = sorted[i];
      // Find first and last entries for this year
      const yearEntries = hist.filter((h) => parseInt(h.date.substring(0, 4)) === y);
      if (yearEntries.length < 2) continue;
      // For years after the first, use the last day of the previous year as start
      let startVal: number;
      if (i === 0) {
        startVal = yearEntries[0].value;
      } else {
        // Last value of previous year
        const prevYear = sorted[i - 1][0];
        const prevEntries = hist.filter((h) => parseInt(h.date.substring(0, 4)) === prevYear);
        startVal = prevEntries[prevEntries.length - 1].value;
      }
      const endVal = yearEntries[yearEntries.length - 1].value;
      proper.push({ year: y, return: ((endVal - startVal) / startVal) * 100 });
    }

    return proper;
  }, [selectedModel]);

  // Chart rendering
  const chartWidth = 800;
  const chartHeight = 200;
  const chartPadding = { top: 10, right: 10, bottom: 25, left: 50 };

  const chartData = useMemo(() => {
    if (filteredHistory.length < 2) return null;
    const values = filteredHistory.map((h) => h.value);
    const minV = Math.min(...values) * 0.998;
    const maxV = Math.max(...values) * 1.002;
    const range = maxV - minV || 1;

    const innerW = chartWidth - chartPadding.left - chartPadding.right;
    const innerH = chartHeight - chartPadding.top - chartPadding.bottom;

    const points = filteredHistory.map((h, i) => ({
      x: chartPadding.left + (i / (filteredHistory.length - 1)) * innerW,
      y: chartPadding.top + innerH - ((h.value - minV) / range) * innerH,
      date: h.date,
      value: h.value,
      ret: h.dailyReturn,
    }));

    const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const areaPath = pathD
      + ` L${points[points.length - 1].x.toFixed(1)},${chartPadding.top + innerH}`
      + ` L${points[0].x.toFixed(1)},${chartPadding.top + innerH} Z`;

    const yLabels = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = minV + (range * i) / steps;
      const y = chartPadding.top + innerH - (i / steps) * innerH;
      yLabels.push({ y, label: v.toFixed(1) });
    }

    const xLabels = [];
    const xStep = Math.max(1, Math.floor(filteredHistory.length / 5));
    for (let i = 0; i < filteredHistory.length; i += xStep) {
      xLabels.push({ x: points[i].x, label: fmtDate(filteredHistory[i].date) });
    }

    const isPositive = points[points.length - 1].value >= points[0].value;
    return { points, path: pathD, areaPath, yLabels, xLabels, isPositive, minV, maxV };
  }, [filteredHistory]);

  const availableProfiles = groupModels.map((m) => m.profile);
  const activeProfile = availableProfiles.includes(selectedProfile) ? selectedProfile : availableProfiles[0] || "allEquity";

  const trackingStartLabel = trackingStart
    ? new Date((trackingStart as { date: string }).date + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  // Inception to date return (from full history)
  const itdStats = useMemo(() => {
    if (!selectedModel || selectedModel.history.length < 2) return null;
    const h = selectedModel.history;
    const first = h[0];
    const last = h[h.length - 1];
    const totalReturn = ((last.value - first.value) / first.value) * 100;
    const days = h.length;
    const years = days / 252;
    const annualized = years > 1 ? (Math.pow(last.value / first.value, 1 / years) - 1) * 100 : null;
    return { totalReturn, annualized, startDate: first.date, endDate: last.date, years };
  }, [selectedModel]);

  if (!trackingStart && (!perfData || groupModels.length === 0)) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h2 className="text-sm font-bold text-slate-800 mb-2">Performance Tracker</h2>
        <p className="text-xs text-slate-400">
          Performance tracking has not been started for this model. Import historical data or set an initial rebalance to begin.
        </p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-slate-300 border-t-blue-500" />
          <span className="text-sm text-slate-500">Loading performance data...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm space-y-4">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-bold text-slate-800">Performance Tracker</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            {groupName} model
            {trackingStartLabel && <> &middot; tracking since {trackingStartLabel}</>}
            {itdStats && (
              <> &middot; <span className={itdStats.totalReturn >= 0 ? "text-emerald-600" : "text-red-500"}>
                {fmtPct(itdStats.totalReturn)} ITD
                {itdStats.annualized != null && <> ({fmtPct(itdStats.annualized)} ann.)</>}
              </span></>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {autoUpdating && (
            <span className="flex items-center gap-1 text-[10px] text-blue-500 font-medium">
              <div className="h-3 w-3 animate-spin rounded-full border border-blue-300 border-t-blue-500" />
              Updating...
            </span>
          )}
          <button
            onClick={refreshPerformance}
            disabled={refreshing}
            className="flex items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:bg-slate-200 transition-colors disabled:opacity-50"
          >
            <svg className={`w-3.5 h-3.5 ${refreshing ? "animate-spin" : ""}`} fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0 3.181 3.183a8.25 8.25 0 0 0 13.803-3.7M4.031 9.865a8.25 8.25 0 0 1 13.803-3.7l3.181 3.182" />
            </svg>
            {refreshing ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {/* Profile tabs + Period selector */}
      {availableProfiles.length > 0 && (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          {availableProfiles.length > 1 && (
            <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
              {availableProfiles.map((p) => (
                <button
                  key={p}
                  onClick={() => setSelectedProfile(p)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
                    activeProfile === p ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
                  }`}
                >
                  {PROFILE_LABELS[p]}
                </button>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            {PERIOD_OPTIONS.map((p) => (
              <button
                key={p.label}
                onClick={() => setPeriod(p.label)}
                className={`rounded-lg px-2.5 py-1 text-[10px] font-bold transition-colors ${
                  period === p.label ? "bg-slate-800 text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2">
          <div className="rounded-lg bg-slate-50 p-2.5 text-center">
            <div className="text-[9px] font-semibold text-slate-400 uppercase">Period Return</div>
            <div className={`text-base font-bold ${stats.totalReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(stats.totalReturn)}</div>
          </div>
          {stats.annualizedReturn != null && (
            <div className="rounded-lg bg-slate-50 p-2.5 text-center">
              <div className="text-[9px] font-semibold text-slate-400 uppercase">Annualized</div>
              <div className={`text-base font-bold ${stats.annualizedReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(stats.annualizedReturn)}</div>
            </div>
          )}
          <div className="rounded-lg bg-slate-50 p-2.5 text-center">
            <div className="text-[9px] font-semibold text-slate-400 uppercase">Today</div>
            <div className={`text-base font-bold ${stats.lastDailyReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(stats.lastDailyReturn)}</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2.5 text-center">
            <div className="text-[9px] font-semibold text-slate-400 uppercase">Index</div>
            <div className="text-base font-bold text-slate-700">{stats.lastValue.toFixed(2)}</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2.5 text-center">
            <div className="text-[9px] font-semibold text-slate-400 uppercase">Best Day</div>
            <div className="text-base font-bold text-emerald-600">{fmtPct(stats.maxDay)}</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2.5 text-center">
            <div className="text-[9px] font-semibold text-slate-400 uppercase">Worst Day</div>
            <div className="text-base font-bold text-red-500">{fmtPct(stats.minDay)}</div>
          </div>
          <div className="rounded-lg bg-slate-50 p-2.5 text-center">
            <div className="text-[9px] font-semibold text-slate-400 uppercase">Ann. Vol</div>
            <div className="text-base font-bold text-slate-700">{stats.annualizedVol.toFixed(1)}%</div>
          </div>
        </div>
      )}

      {/* Chart */}
      {chartData ? (
        <div className="w-full overflow-x-auto">
          <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} className="w-full h-auto min-w-[400px]" preserveAspectRatio="xMidYMid meet">
            {chartData.yLabels.map((yl, i) => (
              <g key={i}>
                <line x1={chartPadding.left} x2={chartWidth - chartPadding.right} y1={yl.y} y2={yl.y} stroke="#e2e8f0" strokeWidth="0.5" />
                <text x={chartPadding.left - 5} y={yl.y + 3} textAnchor="end" className="text-[8px] fill-slate-400">{yl.label}</text>
              </g>
            ))}
            {chartData.xLabels.map((xl, i) => (
              <text key={i} x={xl.x} y={chartHeight - 5} textAnchor="middle" className="text-[7px] fill-slate-400">{xl.label}</text>
            ))}
            <path d={chartData.areaPath} fill={chartData.isPositive ? "rgba(16,185,129,0.08)" : "rgba(239,68,68,0.08)"} />
            <path d={chartData.path} fill="none" stroke={chartData.isPositive ? "#10b981" : "#ef4444"} strokeWidth="2" strokeLinejoin="round" />
            {chartData.minV < 100 && chartData.maxV > 100 && (
              <line
                x1={chartPadding.left}
                x2={chartWidth - chartPadding.right}
                y1={chartPadding.top + (chartHeight - chartPadding.top - chartPadding.bottom) - ((100 - chartData.minV) / (chartData.maxV - chartData.minV)) * (chartHeight - chartPadding.top - chartPadding.bottom)}
                y2={chartPadding.top + (chartHeight - chartPadding.top - chartPadding.bottom) - ((100 - chartData.minV) / (chartData.maxV - chartData.minV)) * (chartHeight - chartPadding.top - chartPadding.bottom)}
                stroke="#94a3b8" strokeWidth="0.5" strokeDasharray="4,2"
              />
            )}
            {chartData.points.length > 0 && (
              <circle
                cx={chartData.points[chartData.points.length - 1].x}
                cy={chartData.points[chartData.points.length - 1].y}
                r="3"
                fill={chartData.isPositive ? "#10b981" : "#ef4444"}
                stroke="white" strokeWidth="1.5"
              />
            )}
          </svg>
        </div>
      ) : (
        <div className="flex items-center justify-center h-40 text-sm text-slate-400">
          {groupModels.length === 0
            ? "No performance data yet. Click Refresh to compute returns since tracking started."
            : "Not enough data for this period."}
        </div>
      )}

      {/* Calendar year returns */}
      {calendarYearReturns.length > 1 && (
        <div>
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-2">Calendar Year Returns</h3>
          <div className="flex flex-wrap gap-1.5">
            {calendarYearReturns.map((yr) => (
              <div key={yr.year} className="rounded-lg bg-slate-50 px-3 py-1.5 text-center min-w-[70px]">
                <div className="text-[9px] font-semibold text-slate-400">{yr.year}</div>
                <div className={`text-xs font-bold ${yr.return >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(yr.return)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Daily returns table (last 10 days) */}
      {filteredHistory.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-600 font-semibold py-1">
            Daily Returns (last 10 trading days)
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="text-left py-1 font-semibold">Date</th>
                  <th className="text-right py-1 font-semibold">Daily</th>
                  <th className="text-right py-1 font-semibold">Cumulative</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.slice(1).slice(-10).reverse().map((h) => (
                  <tr key={h.date} className="border-b border-slate-50">
                    <td className="py-1 text-slate-600">{fmtDateFull(h.date)}</td>
                    <td className={`py-1 text-right font-semibold ${h.dailyReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(h.dailyReturn)}</td>
                    <td className={`py-1 text-right font-mono ${h.value >= 100 ? "text-emerald-600" : "text-red-500"}`}>{h.value.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {/* Portfolio daily value table (collapsible) */}
      {selectedModel && selectedModel.history.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-slate-400 hover:text-slate-600 font-semibold py-1">
            Portfolio Value History (last 20 trading days)
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100 text-slate-500">
                  <th className="text-left py-1 font-semibold">Date</th>
                  <th className="text-right py-1 font-semibold">Index Value</th>
                  <th className="text-right py-1 font-semibold">Daily Change</th>
                  <th className="text-right py-1 font-semibold">ITD Return</th>
                </tr>
              </thead>
              <tbody>
                {selectedModel.history.slice(-20).reverse().map((h) => {
                  const itdReturn = ((h.value - 100) / 100) * 100;
                  return (
                    <tr key={h.date} className="border-b border-slate-50">
                      <td className="py-1 text-slate-600">{fmtDateFull(h.date)}</td>
                      <td className="py-1 text-right font-mono text-slate-700">{h.value.toFixed(2)}</td>
                      <td className={`py-1 text-right font-semibold ${h.dailyReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>
                        {h.dailyReturn !== 0 ? fmtPct(h.dailyReturn) : "--"}
                      </td>
                      <td className={`py-1 text-right font-mono ${itdReturn >= 0 ? "text-emerald-600" : "text-red-500"}`}>{fmtPct(itdReturn)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </div>
  );
}
