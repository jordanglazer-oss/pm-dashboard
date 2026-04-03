"use client";

import React, { useState, useMemo, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useStocks } from "@/app/lib/StockContext";
import type { ScoredStock, Stock, ScoreKey } from "@/app/lib/types";
import type { TechnicalIndicators, ImprovingScore } from "@/app/lib/technicals";
import type { UniverseKey } from "@/app/lib/universes";
import { UNIVERSE_LABELS } from "@/app/lib/universes";

// ── Signal helpers (shared) ──

type FilterKey = "trend" | "rsi" | "macd" | "ichimoku" | "volume" | "week52";
type FilterOption = "all" | "bullish" | "bearish" | "neutral";

const FILTER_LABELS: Record<FilterKey, string> = {
  trend: "Trend (DMA)",
  rsi: "RSI",
  macd: "MACD",
  ichimoku: "Ichimoku",
  volume: "Volume",
  week52: "52-Week Position",
};

function getTrendSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.dmaSignal === "golden_cross" || t.dmaSignal === "above_both") return "bullish";
  if (t.dmaSignal === "death_cross" || t.dmaSignal === "below_both") return "bearish";
  return "neutral";
}

function getRsiSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  if (t.rsi14 < 30) return "bullish";
  if (t.rsi14 > 70) return "bearish";
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

function compositeTechnicalScore(t: TechnicalIndicators): { bullish: number; bearish: number; neutral: number; net: number } {
  const signals = [getTrendSignal(t), getRsiSignal(t), getMacdSignal(t), getIchimokuSignal(t), getVolumeSignal(t), getWeek52Signal(t)];
  const bullish = signals.filter((s) => s === "bullish").length;
  const bearish = signals.filter((s) => s === "bearish").length;
  const neutral = signals.filter((s) => s === "neutral").length;
  return { bullish, bearish, neutral, net: bullish - bearish };
}

// ── Shared UI components ──

function TechPill({ signal }: { signal: "bullish" | "bearish" | "neutral" }) {
  const styles =
    signal === "bullish" ? "bg-emerald-100 text-emerald-700"
    : signal === "bearish" ? "bg-red-100 text-red-700"
    : "bg-slate-100 text-slate-500";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold ${styles}`}>
      {signal === "bullish" ? "+" : signal === "bearish" ? "-" : "~"}
    </span>
  );
}

function CompositeBar({ bullish, bearish, neutral }: { bullish: number; bearish: number; neutral: number }) {
  const total = 6;
  return (
    <div className="flex h-2.5 rounded-full overflow-hidden bg-slate-100 w-24">
      {bullish > 0 && <div className="bg-emerald-500 transition-all" style={{ width: `${(bullish / total) * 100}%` }} />}
      {neutral > 0 && <div className="bg-slate-300 transition-all" style={{ width: `${(neutral / total) * 100}%` }} />}
      {bearish > 0 && <div className="bg-red-500 transition-all" style={{ width: `${(bearish / total) * 100}%` }} />}
    </div>
  );
}

function ImprovingBar({ score }: { score: number }) {
  return (
    <div className="flex h-2 rounded-full overflow-hidden bg-slate-100 w-16">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={`flex-1 ${i < score ? "bg-teal-500" : ""} ${i > 0 ? "ml-px" : ""}`} />
      ))}
    </div>
  );
}

// ── Scan result type (matches API response) ──

type ScanResult = {
  ticker: string;
  name: string;
  price: number;
  priceChange5d: number;
  priceChange20d: number;
  technicals: TechnicalIndicators;
  improving: ImprovingScore;
};

// ── Zero scores constant ──

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

// ── Main component ──

type SortKey = "ticker" | "composite" | "trend" | "rsi" | "macd" | "ichimoku" | "momentum" | "improving";
type SortDir = "asc" | "desc";

type Props = {
  stocks: ScoredStock[];
  onAddToWatchlist?: (stock: Stock) => void;
};

export function TechnicalScreener({ stocks, onAddToWatchlist }: Props) {
  const router = useRouter();
  const { scannerData, setScannerData } = useStocks();
  const [tab, setTab] = useState<"portfolio" | "scan">("portfolio");

  // ── Portfolio tab state ──
  const [query, setQuery] = useState("");
  const [bucketFilter, setBucketFilter] = useState<"All" | "Portfolio" | "Watchlist">("All");
  const [filters, setFilters] = useState<Record<FilterKey, FilterOption>>({
    trend: "all", rsi: "all", macd: "all", ichimoku: "all", volume: "all", week52: "all",
  });
  const [sortKey, setSortKey] = useState<SortKey>("composite");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  // ── Scan tab state (persisted) ──
  const [scanUniverse, setScanUniverse] = useState<UniverseKey>("sp500");
  const [minImprovingScore, setMinImprovingScore] = useState(2);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const [scanResults, setScanResults] = useState<ScanResult[]>((scannerData?.results as ScanResult[]) || []);
  const [scanMeta, setScanMeta] = useState<{ total: number; found: number; scannedAt: string; universe: string; minScore: number } | null>(scannerData?.meta || null);
  const [scanQuery, setScanQuery] = useState("");
  const [scanFilters, setScanFilters] = useState<Record<FilterKey, FilterOption>>({
    trend: "all", rsi: "all", macd: "all", ichimoku: "all", volume: "all", week52: "all",
  });
  const [scanSortKey, setScanSortKey] = useState<"improving" | "momentum" | "ticker" | "rsi" | "composite">("improving");
  const [scanSortDir, setScanSortDir] = useState<SortDir>("desc");
  const [addedTickers, setAddedTickers] = useState<Set<string>>(new Set());

  const existingTickers = useMemo(() => stocks.map((s) => s.ticker), [stocks]);

  // Hydrate scanner state when KV data loads
  useEffect(() => {
    if (scannerData && scanResults.length === 0) {
      if (scannerData.results?.length) setScanResults(scannerData.results as ScanResult[]);
      if (scannerData.meta) setScanMeta(scannerData.meta);
    }
  }, [scannerData]); // eslint-disable-line react-hooks/exhaustive-deps

  const setScanFilter = (key: FilterKey, value: FilterOption) => setScanFilters((prev) => ({ ...prev, [key]: value }));
  const activeScanFilterCount = Object.values(scanFilters).filter((v) => v !== "all").length;

  // ── Portfolio tab logic ──
  const stocksWithTechnicals = useMemo(() => stocks.filter((s) => s.technicals != null), [stocks]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setSortKey(key); setSortDir("desc"); }
  };

  const setFilter = (key: FilterKey, value: FilterOption) => setFilters((prev) => ({ ...prev, [key]: value }));
  const activeFilterCount = Object.values(filters).filter((v) => v !== "all").length;

  const filtered = useMemo(() => {
    let result = stocksWithTechnicals;
    if (query) {
      const q = query.toLowerCase();
      result = result.filter((s) => `${s.ticker} ${s.name} ${s.sector}`.toLowerCase().includes(q));
    }
    if (bucketFilter !== "All") result = result.filter((s) => s.bucket === bucketFilter);
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
    result = [...result].sort((a, b) => {
      const ta = a.technicals!; const tb = b.technicals!;
      let cmp = 0;
      switch (sortKey) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "composite": cmp = compositeTechnicalScore(ta).net - compositeTechnicalScore(tb).net; break;
        case "trend": { const o = { bullish: 2, neutral: 1, bearish: 0 }; cmp = o[getTrendSignal(ta)] - o[getTrendSignal(tb)]; break; }
        case "rsi": cmp = ta.rsi14 - tb.rsi14; break;
        case "macd": cmp = ta.macdHistogram - tb.macdHistogram; break;
        case "ichimoku": { const o = { bullish: 2, neutral: 1, bearish: 0 }; cmp = o[getIchimokuSignal(ta)] - o[getIchimokuSignal(tb)]; break; }
        case "momentum": cmp = ta.priceChange20d - tb.priceChange20d; break;
      }
      return sortDir === "desc" ? -cmp : cmp;
    });
    return result;
  }, [stocksWithTechnicals, query, bucketFilter, filters, sortKey, sortDir]);

  const noTechnicalsCount = stocks.length - stocksWithTechnicals.length;
  const bullishCount = filtered.filter((s) => compositeTechnicalScore(s.technicals!).net >= 2).length;
  const bearishCount = filtered.filter((s) => compositeTechnicalScore(s.technicals!).net <= -2).length;
  const neutralCount = filtered.length - bullishCount - bearishCount;

  // ── Scan tab logic ──
  async function handleScan() {
    setScanning(true);
    setScanProgress(`Scanning ${UNIVERSE_LABELS[scanUniverse]}...`);
    setAddedTickers(new Set());
    try {
      const res = await fetch("/api/scan-universe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          universe: scanUniverse,
          minScore: minImprovingScore,
          existingTickers,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Scan failed (${res.status})`);
      }
      const data = await res.json();
      const results = data.results || [];
      const meta = { total: data.total, found: data.found, scannedAt: data.scannedAt, universe: scanUniverse, minScore: minImprovingScore };
      setScanResults(results);
      setScanMeta(meta);
      setScannerData({ results, meta });
      setScanProgress("");
    } catch (err) {
      setScanProgress(err instanceof Error ? err.message : "Scan failed");
    } finally {
      setScanning(false);
    }
  }

  function handleAddToWatchlist(result: ScanResult) {
    if (!onAddToWatchlist) return;
    const stock: Stock = {
      ticker: result.ticker.replace(".TO", ""),
      name: result.name || result.ticker,
      bucket: "Watchlist",
      sector: "Technology", // default — will be updated on first score
      beta: 1.0,
      weights: { portfolio: 0 },
      scores: { ...ZERO_SCORES },
      notes: `Added from ${UNIVERSE_LABELS[scanUniverse]} scan. Improving score: ${result.improving.score}/6.`,
      price: result.price,
      technicals: result.technicals,
    };
    onAddToWatchlist(stock);
    setAddedTickers((prev) => new Set(prev).add(result.ticker));
  }

  const filteredScanResults = useMemo(() => {
    let results = scanResults;
    if (scanQuery) {
      const q = scanQuery.toLowerCase();
      results = results.filter((r) => r.ticker.toLowerCase().includes(q));
    }
    // Apply signal filters
    results = results.filter((r) => {
      const t = r.technicals;
      if (scanFilters.trend !== "all" && getTrendSignal(t) !== scanFilters.trend) return false;
      if (scanFilters.rsi !== "all" && getRsiSignal(t) !== scanFilters.rsi) return false;
      if (scanFilters.macd !== "all" && getMacdSignal(t) !== scanFilters.macd) return false;
      if (scanFilters.ichimoku !== "all" && getIchimokuSignal(t) !== scanFilters.ichimoku) return false;
      if (scanFilters.volume !== "all" && getVolumeSignal(t) !== scanFilters.volume) return false;
      if (scanFilters.week52 !== "all" && getWeek52Signal(t) !== scanFilters.week52) return false;
      return true;
    });
    return [...results].sort((a, b) => {
      let cmp = 0;
      switch (scanSortKey) {
        case "improving": cmp = a.improving.score - b.improving.score; break;
        case "momentum": cmp = a.priceChange20d - b.priceChange20d; break;
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "rsi": cmp = a.technicals.rsi14 - b.technicals.rsi14; break;
        case "composite": cmp = compositeTechnicalScore(a.technicals).net - compositeTechnicalScore(b.technicals).net; break;
      }
      return scanSortDir === "desc" ? -cmp : cmp;
    });
  }, [scanResults, scanQuery, scanFilters, scanSortKey, scanSortDir]);

  const toggleScanSort = (key: typeof scanSortKey) => {
    if (scanSortKey === key) setScanSortDir((d) => (d === "desc" ? "asc" : "desc"));
    else { setScanSortKey(key); setScanSortDir("desc"); }
  };

  // ── Sort header component ──
  const SortHeader = ({ label, sortId, className = "" }: { label: string; sortId: SortKey; className?: string }) => (
    <th className={`pb-3 cursor-pointer select-none hover:text-slate-700 transition-colors ${className}`} onClick={() => toggleSort(sortId)}>
      <div className="flex items-center gap-1">
        {label}
        {sortKey === sortId && <span className="text-blue-600">{sortDir === "desc" ? "\u2193" : "\u2191"}</span>}
      </div>
    </th>
  );

  return (
    <section className="space-y-4">
      {/* Tab bar */}
      <div className="flex rounded-2xl border border-slate-200 overflow-hidden bg-white">
        <button
          onClick={() => setTab("portfolio")}
          className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
            tab === "portfolio" ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          My Stocks
        </button>
        <button
          onClick={() => setTab("scan")}
          className={`flex-1 px-6 py-3 text-sm font-semibold transition-colors ${
            tab === "scan" ? "bg-teal-700 text-white" : "text-slate-600 hover:bg-slate-50"
          }`}
        >
          Universe Scanner
        </button>
      </div>

      {tab === "portfolio" && (
        <>
          {/* Portfolio header */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
              <div>
                <h3 className="text-2xl font-semibold">Technical Screener</h3>
                <p className="text-sm text-slate-500 mt-1">
                  Screen stocks by technical signals across 6 factors. {stocksWithTechnicals.length} stocks with data.
                  {noTechnicalsCount > 0 && <span className="text-amber-600 ml-1">({noTechnicalsCount} need scoring)</span>}
                </p>
              </div>
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ticker, name, or sector"
                className="w-full min-w-[260px] rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400 md:w-auto" />
            </div>

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

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <div className="flex rounded-xl border border-slate-200 overflow-hidden text-sm">
                {(["All", "Portfolio", "Watchlist"] as const).map((b) => (
                  <button key={b} onClick={() => setBucketFilter(b)}
                    className={`px-3 py-1.5 font-medium transition-colors ${bucketFilter === b ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-50"}`}>
                    {b}
                  </button>
                ))}
              </div>
              {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
                <select key={key} value={filters[key]} onChange={(e) => setFilter(key, e.target.value as FilterOption)}
                  className={`rounded-xl border px-3 py-1.5 text-sm outline-none transition-colors ${
                    filters[key] !== "all" ? "border-blue-400 bg-blue-50 text-blue-700 font-semibold" : "border-slate-200 bg-white text-slate-600"
                  }`}>
                  <option value="all">{FILTER_LABELS[key]}: All</option>
                  <option value="bullish">Bullish</option>
                  <option value="bearish">Bearish</option>
                  <option value="neutral">Neutral</option>
                </select>
              ))}
              {activeFilterCount > 0 && (
                <button onClick={() => setFilters({ trend: "all", rsi: "all", macd: "all", ichimoku: "all", volume: "all", week52: "all" })}
                  className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 transition-colors">
                  Clear filters ({activeFilterCount})
                </button>
              )}
            </div>
          </div>

          {/* Portfolio results table */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm overflow-x-auto">
            <div className="text-sm text-slate-500 mb-3">{filtered.length} of {stocksWithTechnicals.length} stocks</div>
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
                  const compositeColor = composite.net >= 3 ? "text-emerald-700 bg-emerald-50" : composite.net >= 1 ? "text-emerald-600" : composite.net <= -3 ? "text-red-700 bg-red-50" : composite.net <= -1 ? "text-red-600" : "text-slate-500";
                  return (
                    <tr key={s.ticker} className="border-b border-slate-100 align-middle cursor-pointer hover:bg-slate-50/50 transition-colors"
                      onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}>
                      <td className="py-3"><div className="font-semibold text-slate-900 font-mono">{s.ticker}</div><div className="text-xs text-slate-400">{s.name}</div></td>
                      <td className="py-3 text-xs text-slate-500">{s.sector}</td>
                      <td className="py-3"><div className="flex items-center gap-2"><span className={`text-sm font-bold rounded px-1.5 py-0.5 ${compositeColor}`}>{composite.net > 0 ? "+" : ""}{composite.net}</span><CompositeBar bullish={composite.bullish} bearish={composite.bearish} neutral={composite.neutral} /></div></td>
                      <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getTrendSignal(t)} /><span className="text-xs text-slate-500">{t.dmaSignal.replace(/_/g, " ")}</span></div></td>
                      <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getRsiSignal(t)} /><span className={`text-xs font-mono ${t.rsi14 > 70 ? "text-red-600" : t.rsi14 < 30 ? "text-emerald-600" : "text-slate-600"}`}>{t.rsi14.toFixed(0)}</span></div></td>
                      <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getMacdSignal(t)} /><span className={`text-xs font-mono ${t.macdHistogram >= 0 ? "text-emerald-600" : "text-red-600"}`}>{t.macdHistogram >= 0 ? "+" : ""}{t.macdHistogram.toFixed(2)}</span></div></td>
                      <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getIchimokuSignal(t)} /><span className="text-xs text-slate-500">{t.ichimoku.overallSignal.replace(/_/g, " ")}</span></div></td>
                      <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getVolumeSignal(t)} /><span className="text-xs text-slate-500 font-mono">{t.volumeRatio.toFixed(1)}x</span></div></td>
                      <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getWeek52Signal(t)} /><span className="text-xs text-slate-500 font-mono">{(t.week52Position * 100).toFixed(0)}%</span></div></td>
                      <td className="py-3"><span className={`text-sm font-semibold ${t.priceChange20d >= 0 ? "text-emerald-600" : "text-red-600"}`}>{t.priceChange20d >= 0 ? "+" : ""}{t.priceChange20d.toFixed(1)}%</span></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filtered.length === 0 && (
              <div className="text-center py-12 text-slate-400">
                {stocksWithTechnicals.length === 0 ? "No stocks have technical data yet. Score stocks to generate technicals." : "No stocks match the current filters."}
              </div>
            )}
          </div>
        </>
      )}

      {tab === "scan" && (
        <>
          {/* Scanner controls */}
          <div className="rounded-[30px] border border-teal-200 bg-white p-6 shadow-sm">
            <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
              <div>
                <h3 className="text-2xl font-semibold">Universe Scanner</h3>
                <p className="text-sm text-slate-500 mt-1">
                  Scan an index universe for stocks showing improving technical signals.
                  Identifies stocks trending <span className="font-semibold text-teal-700">toward</span> positive territory — not already there.
                </p>
                {scanMeta && (
                  <p className="text-xs text-slate-400 mt-1">
                    Last scanned: {new Date(scanMeta.scannedAt).toLocaleString("en-US", {
                      month: "short", day: "numeric", year: "numeric",
                      hour: "numeric", minute: "2-digit", hour12: true,
                    })} — {UNIVERSE_LABELS[scanMeta.universe as UniverseKey] || scanMeta.universe}, min score {scanMeta.minScore}/6
                  </p>
                )}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              {/* Universe selector */}
              <select value={scanUniverse} onChange={(e) => setScanUniverse(e.target.value as UniverseKey)}
                className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 outline-none">
                {(Object.keys(UNIVERSE_LABELS) as UniverseKey[]).map((k) => (
                  <option key={k} value={k}>{UNIVERSE_LABELS[k]}</option>
                ))}
              </select>

              {/* Min improving score */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-slate-500">Min score:</span>
                <select value={minImprovingScore} onChange={(e) => setMinImprovingScore(Number(e.target.value))}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm outline-none">
                  <option value={1}>1/6 (Weak+)</option>
                  <option value={2}>2/6 (Moderate+)</option>
                  <option value={3}>3/6 (Moderate-Strong)</option>
                  <option value={4}>4/6 (Strong)</option>
                </select>
              </div>

              {/* Scan button */}
              <button onClick={handleScan} disabled={scanning}
                className="rounded-xl bg-teal-700 px-6 py-2.5 text-sm font-semibold text-white hover:bg-teal-800 disabled:opacity-50 transition-colors">
                {scanning ? "Scanning..." : `Scan ${UNIVERSE_LABELS[scanUniverse]}`}
              </button>

              {scanProgress && (
                <span className={`text-sm ${scanning ? "text-teal-600" : "text-red-500"}`}>
                  {scanning && (
                    <span className="inline-block w-3 h-3 border-2 border-teal-600 border-t-transparent rounded-full animate-spin mr-2 align-middle" />
                  )}
                  {scanProgress}
                </span>
              )}
            </div>

            {/* Signal filters (same as portfolio tab) */}
            {scanResults.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
                  <select key={key} value={scanFilters[key]} onChange={(e) => setScanFilter(key, e.target.value as FilterOption)}
                    className={`rounded-xl border px-3 py-1.5 text-sm outline-none transition-colors ${
                      scanFilters[key] !== "all" ? "border-teal-400 bg-teal-50 text-teal-700 font-semibold" : "border-slate-200 bg-white text-slate-600"
                    }`}>
                    <option value="all">{FILTER_LABELS[key]}: All</option>
                    <option value="bullish">Bullish</option>
                    <option value="bearish">Bearish</option>
                    <option value="neutral">Neutral</option>
                  </select>
                ))}
                {activeScanFilterCount > 0 && (
                  <button onClick={() => setScanFilters({ trend: "all", rsi: "all", macd: "all", ichimoku: "all", volume: "all", week52: "all" })}
                    className="rounded-xl border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 transition-colors">
                    Clear filters ({activeScanFilterCount})
                  </button>
                )}
              </div>
            )}

            {/* Improving signals legend */}
            <div className="mt-4 rounded-2xl bg-teal-50 border border-teal-200 p-4">
              <div className="text-xs font-semibold text-teal-800 mb-2">Improving signals detected (6 factors):</div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs text-teal-700">
                <div>RSI Recovery — rising from oversold</div>
                <div>MACD Improving — histogram turning up</div>
                <div>DMA Approach — price nearing 50 DMA from below</div>
                <div>Bullish Crossover — recent golden/MACD/TK cross</div>
                <div>Cloud Breakout — entering or breaking above Ichimoku</div>
                <div>Accumulation — high volume on up days</div>
              </div>
            </div>
          </div>

          {/* Scan results */}
          {scanResults.length > 0 && (
            <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm overflow-x-auto">
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between mb-4">
                <div className="text-sm text-slate-500">
                  {filteredScanResults.length} of {scanResults.length} results
                  {scanMeta && (
                    <span className="text-slate-400 ml-1">(from {scanMeta.total} scanned)</span>
                  )}
                </div>
                <input value={scanQuery} onChange={(e) => setScanQuery(e.target.value)} placeholder="Filter by ticker"
                  className="rounded-2xl border border-slate-200 bg-white px-4 py-2 text-sm outline-none placeholder:text-slate-400 w-48" />
              </div>

              <table className="w-full min-w-[1100px] text-left">
                <thead>
                  <tr className="border-b border-slate-200 text-sm text-slate-500">
                    <th className="pb-3 cursor-pointer" onClick={() => toggleScanSort("ticker")}>
                      Ticker {scanSortKey === "ticker" && (scanSortDir === "desc" ? "\u2193" : "\u2191")}
                    </th>
                    <th className="pb-3">Price</th>
                    <th className="pb-3 cursor-pointer" onClick={() => toggleScanSort("composite")}>
                      Composite {scanSortKey === "composite" && (scanSortDir === "desc" ? "\u2193" : "\u2191")}
                    </th>
                    <th className="pb-3 cursor-pointer" onClick={() => toggleScanSort("improving")}>
                      Improving {scanSortKey === "improving" && (scanSortDir === "desc" ? "\u2193" : "\u2191")}
                    </th>
                    <th className="pb-3">Trend</th>
                    <th className="pb-3 cursor-pointer" onClick={() => toggleScanSort("rsi")}>
                      RSI {scanSortKey === "rsi" && (scanSortDir === "desc" ? "\u2193" : "\u2191")}
                    </th>
                    <th className="pb-3">MACD</th>
                    <th className="pb-3">Ichimoku</th>
                    <th className="pb-3">Volume</th>
                    <th className="pb-3">52W</th>
                    <th className="pb-3 cursor-pointer" onClick={() => toggleScanSort("momentum")}>
                      20d Chg {scanSortKey === "momentum" && (scanSortDir === "desc" ? "\u2193" : "\u2191")}
                    </th>
                    <th className="pb-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {filteredScanResults.map((r) => {
                    const t = r.technicals;
                    const isAdded = addedTickers.has(r.ticker) || existingTickers.includes(r.ticker.replace(".TO", ""));
                    const composite = compositeTechnicalScore(t);
                    const compositeColor = composite.net >= 3 ? "text-emerald-700 bg-emerald-50" : composite.net >= 1 ? "text-emerald-600" : composite.net <= -3 ? "text-red-700 bg-red-50" : composite.net <= -1 ? "text-red-600" : "text-slate-500";
                    const improvingColor = r.improving.score >= 4 ? "text-teal-700 bg-teal-50" : r.improving.score >= 2 ? "text-teal-600" : "text-slate-500";

                    return (
                      <tr key={r.ticker} className="border-b border-slate-100 align-middle cursor-pointer hover:bg-slate-50/50 transition-colors"
                        onClick={() => {
                          const clean = r.ticker.replace(".TO", "").toLowerCase();
                          if (existingTickers.includes(clean.toUpperCase()) || existingTickers.includes(r.ticker.replace(".TO", ""))) {
                            router.push(`/stock/${clean}`);
                          } else {
                            // Store scan result for the preview page
                            try { sessionStorage.setItem(`scan_preview_${r.ticker}`, JSON.stringify(r)); } catch {}
                            router.push(`/screener/preview/${encodeURIComponent(r.ticker)}`);
                          }
                        }}>
                        <td className="py-3">
                          <div className="font-semibold text-slate-900 font-mono">{r.ticker}</div>
                          {r.name && r.name !== r.ticker && <div className="text-xs text-slate-400 truncate max-w-[140px]">{r.name}</div>}
                        </td>
                        <td className="py-3 text-sm text-slate-600 font-mono">${r.price.toFixed(2)}</td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold rounded px-1.5 py-0.5 ${compositeColor}`}>{composite.net > 0 ? "+" : ""}{composite.net}</span>
                            <CompositeBar bullish={composite.bullish} bearish={composite.bearish} neutral={composite.neutral} />
                          </div>
                        </td>
                        <td className="py-3">
                          <div className="flex items-center gap-2">
                            <span className={`text-sm font-bold rounded px-1.5 py-0.5 ${improvingColor}`}>
                              {r.improving.score}/6
                            </span>
                            <ImprovingBar score={r.improving.score} />
                          </div>
                        </td>
                        <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getTrendSignal(t)} /><span className="text-xs text-slate-500">{t.dmaSignal.replace(/_/g, " ")}</span></div></td>
                        <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getRsiSignal(t)} /><span className={`text-xs font-mono ${t.rsi14 > 70 ? "text-red-600" : t.rsi14 < 30 ? "text-emerald-600" : "text-slate-600"}`}>{t.rsi14.toFixed(0)}</span></div></td>
                        <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getMacdSignal(t)} /><span className={`text-xs font-mono ${t.macdHistogram >= 0 ? "text-emerald-600" : "text-red-600"}`}>{t.macdHistogram >= 0 ? "+" : ""}{t.macdHistogram.toFixed(2)}</span></div></td>
                        <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getIchimokuSignal(t)} /><span className="text-xs text-slate-500">{t.ichimoku.overallSignal.replace(/_/g, " ")}</span></div></td>
                        <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getVolumeSignal(t)} /><span className="text-xs text-slate-500 font-mono">{t.volumeRatio.toFixed(1)}x</span></div></td>
                        <td className="py-3"><div className="flex items-center gap-1.5"><TechPill signal={getWeek52Signal(t)} /><span className="text-xs text-slate-500 font-mono">{(t.week52Position * 100).toFixed(0)}%</span></div></td>
                        <td className="py-3">
                          <span className={`text-sm font-semibold ${r.priceChange20d >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                            {r.priceChange20d >= 0 ? "+" : ""}{r.priceChange20d.toFixed(1)}%
                          </span>
                        </td>
                        <td className="py-3" onClick={(e) => e.stopPropagation()}>
                          {isAdded ? (
                            <span className="rounded-lg bg-slate-100 px-3 py-1.5 text-xs font-medium text-slate-400">Added</span>
                          ) : (
                            <button onClick={() => handleAddToWatchlist(r)}
                              className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 transition-colors">
                              + Watchlist
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!scanning && scanResults.length === 0 && !scanMeta && (
            <div className="rounded-[30px] border border-slate-200 bg-white p-12 shadow-sm text-center text-slate-400">
              Run a scan to find stocks with improving technical signals.
            </div>
          )}

          {!scanning && scanResults.length === 0 && scanMeta && (
            <div className="rounded-[30px] border border-slate-200 bg-white p-12 shadow-sm text-center text-slate-400">
              No stocks found with improving score {"\u2265"} {minImprovingScore}. Try lowering the minimum score.
            </div>
          )}
        </>
      )}
    </section>
  );
}
