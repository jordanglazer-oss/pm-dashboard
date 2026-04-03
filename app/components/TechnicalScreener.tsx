"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ScoredStock } from "@/app/lib/types";
import type { TechnicalIndicators } from "@/app/lib/technicals";

type FilterKey =
  | "trend"
  | "rsi"
  | "macd"
  | "ichimoku"
  | "volume"
  | "week52";

type FilterOption = "all" | "bullish" | "bearish" | "neutral";

const FILTER_LABELS: Record<FilterKey, string> = {
  trend: "Trend (DMA)",
  rsi: "RSI",
  macd: "MACD",
  ichimoku: "Ichimoku",
  volume: "Volume",
  week52: "52-Week Position",
};

// Derive signal status from technicals
function getTrendSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.dmaSignal === "golden_cross" || t.dmaSignal === "above_both") return "bullish";
  if (t.dmaSignal === "death_cross" || t.dmaSignal === "below_both") return "bearish";
  return "neutral";
}

function getRsiSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.rsi14 < 30) return "bullish"; // oversold = buying opportunity
  if (t.rsi14 > 70) return "bearish"; // overbought = risk
  return "neutral";
}

function getMacdSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.macdSignal === "bullish_crossover" || t.macdSignal === "bullish") return "bullish";
  if (t.macdSignal === "bearish_crossover" || t.macdSignal === "bearish") return "bearish";
  return "neutral";
}

function getIchimokuSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const s = t.ichimoku.overallSignal;
  if (s === "strong_bullish" || s === "bullish") return "bullish";
  if (s === "strong_bearish" || s === "bearish") return "bearish";
  return "neutral";
}

function getVolumeSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.volumeSignal === "high_volume" && t.priceChange5d > 0) return "bullish";
  if (t.volumeSignal === "high_volume" && t.priceChange5d < -2) return "bearish";
  return "neutral";
}

function getWeek52Signal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.week52Position >= 0.7) return "bullish";
  if (t.week52Position <= 0.3) return "bearish";
  return "neutral";
}

// Composite technical score: count bullish signals out of 6
function compositeTechnicalScore(t: TechnicalIndicators): { bullish: number; bearish: number; neutral: number; net: number } {
  const signals = [
    getTrendSignal(t),
    getRsiSignal(t),
    getMacdSignal(t),
    getIchimokuSignal(t),
    getVolumeSignal(t),
    getWeek52Signal(t),
  ];
  const bullish = signals.filter((s) => s === "bullish").length;
  const bearish = signals.filter((s) => s === "bearish").length;
  const neutral = signals.filter((s) => s === "neutral").length;
  return { bullish, bearish, neutral, net: bullish - bearish };
}

// Signal pill
function TechPill({ signal }: { signal: "bullish" | "bearish" | "neutral" }) {
  const styles =
    signal === "bullish"
      ? "bg-emerald-100 text-emerald-700"
      : signal === "bearish"
      ? "bg-red-100 text-red-700"
      : "bg-slate-100 text-slate-500";

  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles}`}>
      {signal === "bullish" ? "+" : signal === "bearish" ? "-" : "~"}
    </span>
  );
}

// Composite bar
function CompositeBar({ bullish, bearish, neutral }: { bullish: number; bearish: number; neutral: number }) {
  const total = 6;
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100 w-24">
      {bullish > 0 && (
        <div className="bg-emerald-500 transition-all" style={{ width: `${(bullish / total) * 100}%` }} />
      )}
      {neutral > 0 && (
        <div className="bg-slate-300 transition-all" style={{ width: `${(neutral / total) * 100}%` }} />
      )}
      {bearish > 0 && (
        <div className="bg-red-500 transition-all" style={{ width: `${(bearish / total) * 100}%` }} />
      )}
    </div>
  );
}

type SortKey = "ticker" | "composite" | "trend" | "rsi" | "macd" | "ichimoku" | "momentum";
type SortDir = "asc" | "desc";

export function TechnicalScreener({ stocks }: { stocks: ScoredStock[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [bucketFilter, setBucketFilter] = useState<"All" | "Portfolio" | "Watchlist">("All");
  const [filters, setFilters] = useState<Record<FilterKey, FilterOption>>({
    trend: "all",
    rsi: "all",
    macd: "all",
    ichimoku: "all",
    volume: "all",
    week52: "all",
  });
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // Only stocks with technicals data
  const stocksWithTechnicals = useMemo(
    () => stocks.filter((s) => s.technicals != null),
    [stocks]
  );

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  const setFilter = (key: FilterKey, value: FilterOption) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const activeFilterCount = Object.values(filters).filter((v) => v !== "all").length;

  const filtered = useMemo(() => {
    let result = stocksWithTechnicals;

    // Text search
    if (query) {
      const q = query.toLowerCase();
      result = result.filter((s) =>
        `${s.ticker} ${s.name} ${s.sector}`.toLowerCase().includes(q)
      );
    }

    // Bucket filter
    if (bucketFilter !== "All") {
      result = result.filter((s) => s.bucket === bucketFilter);
    }

    // Technical filters
    result = result.filter((s) => {
      const t = s.technicals!;
      if (filters.trend !== "all" && getTrendSignal(t) !== filters.trend) return false;
      if (filters.rsi !== "all" && getRsiSignal(t) !== filters.rsi) return false;
      if (filters.macd !== "all" && getMacdSignal(t) !== filters.macd) return false;
      if (filters.ichimoku !== "all" && getIchimokuSignal(t) !== filters.ichimoku) return false;
      if (filters.volume !== "all" && getVolumeSignal(t) !== filters.volume) return false;
      if (filters.week52 !== "all" && getWeek52Signal(t) !== filters.week52) return false;
      return true;
    });

    // Sort
    result = [...result].sort((a, b) => {
      const ta = a.technicals!;
      const tb = b.technicals!;
      let cmp = 0;

      switch (sortKey) {
        case "ticker":
          cmp = a.ticker.localeCompare(b.ticker);
          break;
        case "composite":
          cmp = compositeTechnicalScore(ta).net - compositeTechnicalScore(tb).net;
          break;
        case "trend": {
          const order = { bullish: 2, neutral: 1, bearish: 0 };
          cmp = order[getTrendSignal(ta)] - order[getTrendSignal(tb)];
          break;
        }
        case "rsi":
          cmp = ta.rsi14 - tb.rsi14;
          break;
        case "macd": {
          cmp = ta.macdHistogram - tb.macdHistogram;
          break;
        }
        case "ichimoku": {
          const order = { bullish: 2, neutral: 1, bearish: 0 };
          cmp = order[getIchimokuSignal(ta)] - order[getIchimokuSignal(tb)];
          break;
        }
        case "momentum":
          cmp = ta.priceChange20d - tb.priceChange20d;
          break;
      }

      return sortDir === "desc" ? -cmp : cmp;
    });

    return result;
  }, [stocksWithTechnicals, query, bucketFilter, filters, sortKey, sortDir]);

  const noTechnicalsCount = stocks.length - stocksWithTechnicals.length;

  // Summary stats
  const bullishCount = filtered.filter((s) => compositeTechnicalScore(s.technicals!).net >= 2).length;
  const bearishCount = filtered.filter((s) => compositeTechnicalScore(s.technicals!).net <= -2).length;
  const neutralCount = filtered.length - bullishCount - bearishCount;

  const SortHeader = ({ label, sortId, className = "" }: { label: string; sortId: SortKey; className?: string }) => (
    <th
      className={`pb-3 cursor-pointer select-none hover:text-slate-700 transition-colors ${className}`}
      onClick={() => toggleSort(sortId)}
    >
      <div className="flex items-center gap-1">
        {label}
        {sortKey === sortId && (
          <span className="text-blue-600">{sortDir === "desc" ? "\u2193" : "\u2191"}</span>
        )}
      </div>
    </th>
  );

  return (
    <section className="space-y-4">
      {/* Header */}
      <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h3 className="text-2xl font-semibold">Technical Screener</h3>
            <p className="text-sm text-slate-500 mt-1">
              Screen stocks by technical signals across 6 factors. {stocksWithTechnicals.length} stocks with data.
              {noTechnicalsCount > 0 && (
                <span className="text-amber-600 ml-1">({noTechnicalsCount} need scoring)</span>
              )}
            </p>
          </div>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker, name, or sector"
            className="w-full min-w-[260px] rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400 md:w-auto"
          />
        </div>

        {/* Signal summary cards */}
        <div className="grid grid-cols-3 gap-3 mt-4">
          <div className="rounded-2xl bg-emerald-50 border border-emerald-200 p-3 text-center">
            <div className="text-2xl font-bold text-emerald-700">{bullishCount}</div>
            <div className="text-xs text-emerald-600 font-medium">Bullish (net +2 or more)</div>
          </div>
          <div className="rounded-2xl bg-slate-50 border border-slate-200 p-3 text-center">
            <div className="text-2xl font-bold text-slate-600">{neutralCount}</div>
            <div className="text-xs text-slate-500 font-medium">Neutral</div>
          </div>
          <div className="rounded-2xl bg-red-50 border border-red-200 p-3 text-center">
            <div className="text-2xl font-bold text-red-700">{bearishCount}</div>
            <div className="text-xs text-red-600 font-medium">Bearish (net -2 or more)</div>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {/* Bucket filter */}
          <div className="flex rounded-xl border border-slate-200 overflow-hidden text-sm">
            {(["All", "Portfolio", "Watchlist"] as const).map((b) => (
              <button
                key={b}
                onClick={() => setBucketFilter(b)}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  bucketFilter === b
                    ? "bg-slate-900 text-white"
                    : "text-slate-600 hover:bg-slate-50"
                }`}
              >
                {b}
              </button>
            ))}
          </div>

          {/* Technical signal filters */}
          {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
            <select
              key={key}
              value={filters[key]}
              onChange={(e) => setFilter(key, e.target.value as FilterOption)}
              className={`rounded-xl border px-3 py-1.5 text-sm outline-none transition-colors ${
                filters[key] !== "all"
                  ? "border-blue-400 bg-blue-50 text-blue-700 font-semibold"
                  : "border-slate-200 bg-white text-slate-600"
              }`}
            >
              <option value="all">{FILTER_LABELS[key]}: All</option>
              <option value="bullish">Bullish</option>
              <option value="bearish">Bearish</option>
              <option value="neutral">Neutral</option>
            </select>
          ))}

          {activeFilterCount > 0 && (
            <button
              onClick={() => setFilters({ trend: "all", rsi: "all", macd: "all", ichimoku: "all", volume: "all", week52: "all" })}
              className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 transition-colors"
            >
              Clear filters ({activeFilterCount})
            </button>
          )}
        </div>
      </div>

      {/* Results table */}
      <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm overflow-x-auto">
        <div className="text-sm text-slate-500 mb-3">
          {filtered.length} of {stocksWithTechnicals.length} stocks
        </div>
        <table className="w-full min-w-[1000px] text-left">
          <thead>
            <tr className="border-b border-slate-200 text-sm text-slate-500">
              <SortHeader label="Ticker" sortId="ticker" />
              <th className="pb-3">Sector</th>
              <SortHeader label="Composite" sortId="composite" />
              <SortHeader label="Trend" sortId="trend" />
              <SortHeader label="RSI" sortId="rsi" />
              <SortHeader label="MACD" sortId="macd" />
              <SortHeader label="Ichimoku" sortId="ichimoku" />
              <th className="pb-3">Volume</th>
              <th className="pb-3">52W</th>
              <SortHeader label="20d Chg" sortId="momentum" />
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const t = s.technicals!;
              const composite = compositeTechnicalScore(t);
              const trend = getTrendSignal(t);
              const rsi = getRsiSignal(t);
              const macd = getMacdSignal(t);
              const ichi = getIchimokuSignal(t);
              const vol = getVolumeSignal(t);
              const w52 = getWeek52Signal(t);

              const compositeColor =
                composite.net >= 3
                  ? "text-emerald-700 bg-emerald-50"
                  : composite.net >= 1
                  ? "text-emerald-600"
                  : composite.net <= -3
                  ? "text-red-700 bg-red-50"
                  : composite.net <= -1
                  ? "text-red-600"
                  : "text-slate-500";

              return (
                <tr
                  key={s.ticker}
                  className="border-b border-slate-100 align-middle cursor-pointer hover:bg-slate-50/50 transition-colors"
                  onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}
                >
                  <td className="py-3">
                    <div className="font-semibold text-slate-900 font-mono">{s.ticker}</div>
                    <div className="text-xs text-slate-400">{s.name}</div>
                  </td>
                  <td className="py-3 text-xs text-slate-500">{s.sector}</td>
                  <td className="py-3">
                    <div className="flex items-center gap-2">
                      <span className={`text-sm font-bold rounded px-1.5 py-0.5 ${compositeColor}`}>
                        {composite.net > 0 ? "+" : ""}{composite.net}
                      </span>
                      <CompositeBar bullish={composite.bullish} bearish={composite.bearish} neutral={composite.neutral} />
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <TechPill signal={trend} />
                      <span className="text-xs text-slate-500">{t.dmaSignal.replace(/_/g, " ")}</span>
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <TechPill signal={rsi} />
                      <span className={`text-xs font-mono ${t.rsi14 > 70 ? "text-red-600" : t.rsi14 < 30 ? "text-emerald-600" : "text-slate-600"}`}>
                        {t.rsi14.toFixed(0)}
                      </span>
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <TechPill signal={macd} />
                      <span className={`text-xs font-mono ${t.macdHistogram >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                        {t.macdHistogram >= 0 ? "+" : ""}{t.macdHistogram.toFixed(2)}
                      </span>
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <TechPill signal={ichi} />
                      <span className="text-xs text-slate-500">
                        {t.ichimoku.overallSignal.replace(/_/g, " ")}
                      </span>
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <TechPill signal={vol} />
                      <span className="text-xs text-slate-500 font-mono">
                        {t.volumeRatio.toFixed(1)}x
                      </span>
                    </div>
                  </td>
                  <td className="py-3">
                    <div className="flex items-center gap-1.5">
                      <TechPill signal={w52} />
                      <span className="text-xs text-slate-500 font-mono">
                        {(t.week52Position * 100).toFixed(0)}%
                      </span>
                    </div>
                  </td>
                  <td className="py-3">
                    <span className={`text-sm font-semibold ${t.priceChange20d >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                      {t.priceChange20d >= 0 ? "+" : ""}{t.priceChange20d.toFixed(1)}%
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        {filtered.length === 0 && (
          <div className="text-center py-12 text-slate-400">
            {stocksWithTechnicals.length === 0
              ? "No stocks have technical data yet. Score stocks to generate technicals."
              : "No stocks match the current filters."}
          </div>
        )}
      </div>
    </section>
  );
}
