"use client";

import React, { useState, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { EmptyState } from "@/app/components/EmptyState";
import { AppIcon } from "@/app/components/AppIcon";
import { useStocks } from "@/app/lib/StockContext";
import type { ScoredStock, Stock, ScoreKey } from "@/app/lib/types";
import type { TechnicalIndicators, ImprovingScore } from "@/app/lib/technicals";
import { isScoreable } from "@/app/lib/scoring";
import { displayTicker } from "@/app/lib/ticker";
import type { UniverseKey } from "@/app/lib/universes";
import { UNIVERSE_LABELS } from "@/app/lib/universes";

// ── Signal helpers (shared) ──

type FilterKey =
  | "trend"
  | "rsi"
  | "macd"
  | "ichimoku"
  | "volume"
  | "week52"
  | "ath"
  | "weeklyMacd"
  | "monthlyMacd"
  | "multiTfRsi"
  | "cloudEdge";
type FilterOption = "all" | "bullish" | "bearish" | "neutral";

const FILTER_LABELS: Record<FilterKey, string> = {
  trend: "Trend (DMA)",
  rsi: "RSI",
  macd: "MACD",
  ichimoku: "Ichimoku",
  volume: "Volume",
  week52: "52-Week Position",
  ath: "% From ATH",
  weeklyMacd: "Weekly MACD",
  monthlyMacd: "Monthly MACD",
  multiTfRsi: "RSI Confluence",
  cloudEdge: "Cloud-Edge Dist.",
};

const ALL_FILTERS_CLEARED: Record<FilterKey, FilterOption> = {
  trend: "all", rsi: "all", macd: "all", ichimoku: "all", volume: "all", week52: "all",
  ath: "all", weeklyMacd: "all", monthlyMacd: "all", multiTfRsi: "all", cloudEdge: "all",
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

// ── Newton-toolkit filter helpers ──
// Any indicator missing from the cached blob (older scans) returns "neutral"
// so the filter behaves identically to pre-migration data.

function getAthSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const pct = t.distanceFromATH?.pct;
  if (pct == null) return "neutral";
  if (pct >= -5) return "bullish";       // within 5% of ATH — momentum leader
  if (pct <= -20) return "bearish";      // deeply below ATH — broken trend
  return "neutral";
}

function getWeeklyMacdSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const sig = t.weeklyMacd?.signal;
  if (!sig) return "neutral";
  return sig; // "bullish" | "bearish"
}

function getMonthlyMacdSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const sig = t.monthlyMacd?.signal;
  if (!sig) return "neutral";
  return sig;
}

/**
 * Multi-timeframe RSI confluence: bullish if daily + weekly + monthly RSI
 * are ALL above 50; bearish if ALL below 50; neutral otherwise (mixed
 * or missing data).
 */
function getMultiTfRsiSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const { weeklyRsi, monthlyRsi, rsi14 } = t;
  if (weeklyRsi == null || monthlyRsi == null) return "neutral";
  if (rsi14 > 50 && weeklyRsi > 50 && monthlyRsi > 50) return "bullish";
  if (rsi14 < 50 && weeklyRsi < 50 && monthlyRsi < 50) return "bearish";
  return "neutral";
}

/**
 * Cloud-edge distance: bullish if price well above cloud (>3%), bearish
 * if well below (<-3%), neutral if within 3% of cloud edges or inside.
 */
function getCloudEdgeSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const e = t.distanceFromCloudEdge;
  if (!e) return "neutral";
  if (e.position === "above" && e.pct > 3) return "bullish";
  if (e.position === "below" && e.pct < -3) return "bearish";
  return "neutral";
}

const FILTER_ACCESSORS: Record<FilterKey, (t: TechnicalIndicators) => "bullish" | "bearish" | "neutral"> = {
  trend: getTrendSignal,
  rsi: getRsiSignal,
  macd: getMacdSignal,
  ichimoku: getIchimokuSignal,
  volume: getVolumeSignal,
  week52: getWeek52Signal,
  ath: getAthSignal,
  weeklyMacd: getWeeklyMacdSignal,
  monthlyMacd: getMonthlyMacdSignal,
  multiTfRsi: getMultiTfRsiSignal,
  cloudEdge: getCloudEdgeSignal,
};

/** Map MACD divergence to a directional signal for the composite score.
 *  Bullish divergence = bullish (reversal setup); bearish = bearish; otherwise neutral. */
function getMacdDivergenceSignal(t: TechnicalIndicators): "bullish" | "bearish" | "neutral" {
  const type = t.macdDivergence?.type;
  if (type === "bullish") return "bullish";
  if (type === "bearish") return "bearish";
  return "neutral";
}

// Composite score matches the Risk Alert ladder exactly: 6 factors —
// Trend (DMA), RSI, MACD, Ichimoku, Volume, MACD Divergence. Short
// Interest was dropped from Risk Alert (high short interest isn't
// always bearish), so MACD Divergence takes its slot. 52-Week Position
// is kept as a display column + filter but is not in the composite
// score, because it duplicates what Trend / RSI already express.
const COMPOSITE_TOTAL = 6;

function compositeTechnicalScore(t: TechnicalIndicators): { bullish: number; bearish: number; neutral: number; net: number } {
  const signals = [
    getTrendSignal(t),
    getRsiSignal(t),
    getMacdSignal(t),
    getIchimokuSignal(t),
    getVolumeSignal(t),
    getMacdDivergenceSignal(t),
  ];
  const bullish = signals.filter((s) => s === "bullish").length;
  const bearish = signals.filter((s) => s === "bearish").length;
  const neutral = signals.filter((s) => s === "neutral").length;
  return { bullish, bearish, neutral, net: bullish - bearish };
}

// ── Shared UI components ──

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-40";
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-40";
const BTN22 = "inline-flex h-[22px] items-center gap-1 rounded-control border border-line bg-surface px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-hover hover:text-ink";
const INPUT = "h-7 rounded-control border border-line bg-surface px-2.5 text-[12.5px] outline-none placeholder:text-ink-3 focus:border-accent-border";
const SELECT = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink-2 outline-none";

const SIGNAL_DOT: Record<"bullish" | "bearish" | "neutral", string> = {
  bullish: "bg-pos",
  bearish: "bg-neg",
  neutral: "bg-ink-faint",
};

/** Signal read = dot + the reading beside it (one column, never a pill). */
function Sig({ signal, children }: { signal: "bullish" | "bearish" | "neutral"; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5" title={signal}>
      <span className={`dot ${SIGNAL_DOT[signal]}`} />
      <span className="text-[12px] text-ink-2">{children}</span>
    </span>
  );
}

function CompositeBar({ bullish, bearish, neutral }: { bullish: number; bearish: number; neutral: number }) {
  const total = COMPOSITE_TOTAL;
  return (
    <span className="inline-flex h-1.5 w-16 overflow-hidden rounded-full bg-surface-2 align-middle">
      {bullish > 0 && <span className="bg-pos" style={{ width: `${(bullish / total) * 100}%` }} />}
      {neutral > 0 && <span className="bg-line" style={{ width: `${(neutral / total) * 100}%` }} />}
      {bearish > 0 && <span className="bg-neg" style={{ width: `${(bearish / total) * 100}%` }} />}
    </span>
  );
}

function ImprovingBar({ score }: { score: number }) {
  return (
    <span className="inline-flex h-1.5 w-14 overflow-hidden rounded-full bg-surface-2 align-middle">
      {Array.from({ length: 6 }, (_, i) => (
        <span key={i} className={`flex-1 ${i < score ? "bg-accent" : ""} ${i > 0 ? "ml-px" : ""}`} />
      ))}
    </span>
  );
}

const compositeCls = (net: number) => (net >= 1 ? "text-pos" : net <= -1 ? "text-neg" : "text-ink-3");

/**
 * The eleven signal filters, folded into one `filter` menu so the toolbar
 * stays one row. A menu is deliberately transient (not persisted) — the
 * filter VALUES live in the caller's state exactly as before.
 */
function SignalFilterMenu({
  filters,
  onChange,
  onClear,
}: {
  filters: Record<FilterKey, FilterOption>;
  onChange: (key: FilterKey, value: FilterOption) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const active = Object.values(filters).filter((v) => v !== "all").length;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`${BTN} ${active > 0 ? "!border-accent-border !bg-accent-soft !text-accent" : ""}`}
      >
        <AppIcon name="filter" size={13} strokeWidth={2} />
        Signals
        {active > 0 && <span className="font-mono text-[11px]">{active}</span>}
        <AppIcon name="chevD" size={12} strokeWidth={2} className={active > 0 ? "" : "text-ink-3"} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-20 mt-1 w-[320px] rounded-card border border-line bg-surface p-2 shadow-[var(--shadow-pop)]">
          <div className="flex flex-col gap-1">
            {(Object.keys(FILTER_LABELS) as FilterKey[]).map((key) => (
              <label key={key} className="flex items-center gap-2 text-[12px] text-ink-2">
                <span className={`w-[132px] shrink-0 truncate ${filters[key] !== "all" ? "text-accent" : ""}`}>{FILTER_LABELS[key]}</span>
                <select value={filters[key]} onChange={(e) => onChange(key, e.target.value as FilterOption)} className={`${SELECT} flex-1 ${filters[key] !== "all" ? "border-accent-border text-accent" : ""}`}>
                  <option value="all">All</option>
                  <option value="bullish">Bullish</option>
                  <option value="bearish">Bearish</option>
                  <option value="neutral">Neutral</option>
                </select>
              </label>
            ))}
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-line-soft pt-2">
            <button type="button" onClick={onClear} disabled={active === 0} className="text-[11.5px] text-accent hover:underline disabled:text-ink-faint disabled:no-underline">Clear all</button>
            <button type="button" onClick={() => setOpen(false)} className={BTN22}>Done</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Scan result type (matches API response) ──

type ScanResult = {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  priceChange5d: number;
  priceChange20d: number;
  technicals: TechnicalIndicators;
  improving: ImprovingScore;
};

// ── Zero scores constant ──

const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
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

  // ── Portfolio tab state ──
  const [query, setQuery] = useState("");
  const [bucketFilter, setBucketFilter] = useState<"All" | "Portfolio" | "Watchlist" | "Funds & ETFs">("All");
  const [filters, setFilters] = useState<Record<FilterKey, FilterOption>>({ ...ALL_FILTERS_CLEARED });
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
  const [scanFilters, setScanFilters] = useState<Record<FilterKey, FilterOption>>({ ...ALL_FILTERS_CLEARED });
  const [scanSortKey, setScanSortKey] = useState<"improving" | "momentum" | "ticker" | "rsi" | "composite">("improving");
  const [scanSortDir, setScanSortDir] = useState<SortDir>("desc");
  const [addedTickers, setAddedTickers] = useState<Set<string>>(new Set());

  const existingTickers = useMemo(() => stocks.map((s) => s.ticker), [stocks]);

  // Hydrate scanner state when KV data loads
  useEffect(() => {
    if (scannerData && scanResults.length === 0) {
      const results = (scannerData.results || []) as ScanResult[];
      if (results.length) setScanResults(results);
      if (scannerData.meta) setScanMeta(scannerData.meta);

      // Backfill missing names from Yahoo Finance
      const needsName = results.filter((r) => !r.name || r.name === r.ticker);
      if (needsName.length > 0) {
        const tickers = needsName.map((r) => r.ticker).join(",");
        fetch(`/api/company-name?tickers=${encodeURIComponent(tickers)}`)
          .then((res) => res.ok ? res.json() : null)
          .then((data) => {
            if (!data?.names) return;
            setScanResults((prev) => {
              let changed = false;
              const next = prev.map((r) => {
                const newName = data.names[r.ticker];
                const newSector = data.sectors?.[r.ticker];
                if (newName && (!r.name || r.name === r.ticker)) {
                  changed = true;
                  return { ...r, name: newName, ...(newSector && !r.sector ? { sector: newSector } : {}) };
                }
                return r;
              });
              if (changed && setScannerData) {
                setScannerData({ results: next, meta: scannerData.meta });
              }
              return changed ? next : prev;
            });
          })
          .catch(() => {});
      }
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
    if (bucketFilter === "Funds & ETFs") {
      result = result.filter((s) => !isScoreable(s));
    } else if (bucketFilter === "Portfolio") {
      result = result.filter((s) => s.bucket === "Portfolio" && isScoreable(s));
    } else if (bucketFilter === "Watchlist") {
      result = result.filter((s) => s.bucket === "Watchlist" && isScoreable(s));
    }
    result = result.filter((s) => {
      const t = s.technicals!;
      for (const key of Object.keys(filters) as FilterKey[]) {
        const want = filters[key];
        if (want !== "all" && FILTER_ACCESSORS[key](t) !== want) return false;
      }
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
      sector: result.sector || "Technology",
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
      for (const key of Object.keys(scanFilters) as FilterKey[]) {
        const want = scanFilters[key];
        if (want !== "all" && FILTER_ACCESSORS[key](t) !== want) return false;
      }
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
  const SortHeader = ({ label, sortId, className = "", title }: { label: string; sortId: SortKey; className?: string; title?: string }) => (
    <th className={className} title={title}>
      <button type="button" onClick={() => toggleSort(sortId)} className={`inline-flex items-center gap-0.5 hover:text-ink ${sortKey === sortId ? "text-ink-2" : ""}`}>
        {label}
        {sortKey === sortId && <AppIcon name={sortDir === "desc" ? "chevD" : "chevU"} size={11} strokeWidth={2} />}
      </button>
    </th>
  );
  const ScanSortHeader = ({ label, sortId, className = "" }: { label: string; sortId: typeof scanSortKey; className?: string }) => (
    <th className={className}>
      <button type="button" onClick={() => toggleScanSort(sortId)} className={`inline-flex items-center gap-0.5 hover:text-ink ${scanSortKey === sortId ? "text-ink-2" : ""}`}>
        {label}
        {scanSortKey === sortId && <AppIcon name={scanSortDir === "desc" ? "chevD" : "chevU"} size={11} strokeWidth={2} />}
      </button>
    </th>
  );

  const SORT_LABEL: Record<SortKey, string> = { ticker: "ticker", composite: "composite", trend: "trend", rsi: "RSI", macd: "MACD", ichimoku: "Ichimoku", momentum: "20d change", improving: "improving" };

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar: my stocks ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <div className="seg" role="group" aria-label="Bucket">
          {(["All", "Portfolio", "Watchlist", "Funds & ETFs"] as const).map((b) => (
            <button key={b} onClick={() => setBucketFilter(b)} className={bucketFilter === b ? "on" : ""}>{b}</button>
          ))}
        </div>
        <label className="relative">
          <AppIcon name="search" size={13} strokeWidth={2} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ticker, name, or sector" className={`${INPUT} w-64 pl-7`} />
        </label>
        <SignalFilterMenu filters={filters} onChange={setFilter} onClear={() => setFilters({ ...ALL_FILTERS_CLEARED })} />
        {activeFilterCount > 0 && (
          <button onClick={() => setFilters({ ...ALL_FILTERS_CLEARED })} className={BTN}>
            <AppIcon name="x" size={12} strokeWidth={2} />
            Clear filters ({activeFilterCount})
          </button>
        )}
        <span className="ml-auto text-[11.5px] text-ink-3">
          {stocksWithTechnicals.length} stocks with data
          {noTechnicalsCount > 0 && <span className="text-warn"> · {noTechnicalsCount} need scoring</span>}
        </span>
      </div>

      {/* ── My stocks ── */}
      <section className="panel">
        <div className="panel-h">
          <span className="t">Technical screener</span>
          <span className="m">
            6-factor composite · <span className="text-pos">{bullishCount} bullish</span> · {neutralCount} neutral · <span className="text-neg">{bearishCount} bearish</span>
          </span>
        </div>
        {filtered.length === 0 ? (
          <EmptyState
            className="!py-8"
            glyph={<AppIcon name="search" size={18} />}
            title={stocksWithTechnicals.length === 0 ? "No technical data yet" : "No matches"}
            body={stocksWithTechnicals.length === 0 ? "Score stocks to generate technicals, then they'll show up here." : "No stocks match the current filters — try loosening them."}
          />
        ) : (
          <div className="tbl-wrap">
            <table className="data-table min-w-[1000px]">
              <thead>
                <tr>
                  <SortHeader label="Ticker" sortId="ticker" className="pl-3.5" />
                  <th>Name</th>
                  <th>Sector</th>
                  <SortHeader label="Composite" sortId="composite" className="n" title="Net of 6 signals: Trend, RSI, MACD, Ichimoku, Volume, MACD divergence" />
                  <SortHeader label="Trend" sortId="trend" />
                  <SortHeader label="RSI" sortId="rsi" />
                  <SortHeader label="MACD" sortId="macd" />
                  <SortHeader label="Ichimoku" sortId="ichimoku" />
                  <th>Volume</th>
                  <th>52W</th>
                  <SortHeader label="20d chg" sortId="momentum" className="n pr-3.5" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  const t = s.technicals!;
                  const composite = compositeTechnicalScore(t);
                  return (
                    <tr key={s.ticker} className="cursor-pointer" onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}>
                      <td className="pl-3.5 font-mono font-medium text-ink">{displayTicker(s.ticker)}</td>
                      <td className="max-w-[160px] truncate text-[12px] text-ink-3">{s.name !== s.ticker ? s.name : ""}</td>
                      <td className="text-[12px] text-ink-2">{s.sector}</td>
                      <td className="n">
                        <span className="inline-flex items-center gap-2">
                          <CompositeBar bullish={composite.bullish} bearish={composite.bearish} neutral={composite.neutral} />
                          <span className={`font-medium ${compositeCls(composite.net)}`}>{composite.net > 0 ? "+" : ""}{composite.net}</span>
                        </span>
                      </td>
                      <td><Sig signal={getTrendSignal(t)}>{t.dmaSignal.replace(/_/g, " ")}</Sig></td>
                      <td><Sig signal={getRsiSignal(t)}><span className={`font-mono ${t.rsi14 > 70 ? "text-neg" : t.rsi14 < 30 ? "text-pos" : ""}`}>{t.rsi14.toFixed(0)}</span></Sig></td>
                      <td><Sig signal={getMacdSignal(t)}><span className={`font-mono ${t.macdHistogram >= 0 ? "text-pos" : "text-neg"}`}>{t.macdHistogram >= 0 ? "+" : ""}{t.macdHistogram.toFixed(2)}</span></Sig></td>
                      <td><Sig signal={getIchimokuSignal(t)}>{t.ichimoku.overallSignal.replace(/_/g, " ")}</Sig></td>
                      <td><Sig signal={getVolumeSignal(t)}><span className="font-mono">{t.volumeRatio.toFixed(1)}x</span></Sig></td>
                      <td><Sig signal={getWeek52Signal(t)}><span className="font-mono">{(t.week52Position * 100).toFixed(0)}%</span></Sig></td>
                      <td className={`n pr-3.5 ${t.priceChange20d >= 0 ? "text-pos" : "text-neg"}`}>{t.priceChange20d >= 0 ? "+" : ""}{t.priceChange20d.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
          {filtered.length} of {stocksWithTechnicals.length} · sorted by {SORT_LABEL[sortKey]}
        </div>
      </section>

      {/* ── Universe scanner ── */}
      <section className="panel">
        <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
          <span className="t">Universe scanner</span>
          <span className="m">
            improving signals — stocks trending <span className="text-ink-2">toward</span> positive territory, not already there
            {scanMeta && (
              <>
                {" · last scanned "}
                {new Date(scanMeta.scannedAt).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}
                {" — "}{UNIVERSE_LABELS[scanMeta.universe as UniverseKey] || scanMeta.universe}, min score {scanMeta.minScore}/6
              </>
            )}
          </span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <select value={scanUniverse} onChange={(e) => setScanUniverse(e.target.value as UniverseKey)} className={SELECT} aria-label="Universe">
              {(Object.keys(UNIVERSE_LABELS) as UniverseKey[]).map((k) => (
                <option key={k} value={k}>{UNIVERSE_LABELS[k]}</option>
              ))}
            </select>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-ink-3">
              Min score
              <select value={minImprovingScore} onChange={(e) => setMinImprovingScore(Number(e.target.value))} className={SELECT}>
                <option value={1}>1/6 (Weak+)</option>
                <option value={2}>2/6 (Moderate+)</option>
                <option value={3}>3/6 (Moderate-Strong)</option>
                <option value={4}>4/6 (Strong)</option>
              </select>
            </label>
            <button onClick={handleScan} disabled={scanning} className={BTN_PRI}>
              <AppIcon name={scanning ? "refresh" : "play"} size={13} strokeWidth={2} className={scanning ? "animate-spin" : ""} />
              {scanning ? "Scanning…" : `Scan ${UNIVERSE_LABELS[scanUniverse]}`}
            </button>
          </div>
        </div>

        {scanProgress && (
          <div className={`border-b border-line-soft px-3.5 py-2 text-[12.5px] ${scanning ? "text-ink-2" : "text-neg"}`}>{scanProgress}</div>
        )}

        {/* Improving signals legend */}
        <div className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-5 text-ink-3">
          <span className="text-ink-2">Improving signals (6 factors):</span> RSI recovery — rising from oversold · MACD improving — histogram turning up ·
          DMA approach — price nearing 50 DMA from below · Bullish crossover — recent golden/MACD/TK cross · Cloud breakout — entering or breaking above Ichimoku ·
          Accumulation — high volume on up days
        </div>

        {/* Signal filters (same as the my-stocks toolbar) */}
        {scanResults.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line-soft px-3.5 py-2">
            <label className="relative">
              <AppIcon name="search" size={13} strokeWidth={2} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
              <input value={scanQuery} onChange={(e) => setScanQuery(e.target.value)} placeholder="Filter by ticker" className={`${INPUT} w-48 pl-7`} />
            </label>
            <SignalFilterMenu filters={scanFilters} onChange={setScanFilter} onClear={() => setScanFilters({ ...ALL_FILTERS_CLEARED })} />
            {activeScanFilterCount > 0 && (
              <button onClick={() => setScanFilters({ ...ALL_FILTERS_CLEARED })} className={BTN}>
                <AppIcon name="x" size={12} strokeWidth={2} />
                Clear filters ({activeScanFilterCount})
              </button>
            )}
            <span className="ml-auto text-[11.5px] text-ink-3">
              {filteredScanResults.length} of {scanResults.length} results{scanMeta && ` (from ${scanMeta.total} scanned)`}
            </span>
          </div>
        )}

        {scanResults.length > 0 && (
          <div className="tbl-wrap">
            <table className="data-table min-w-[1100px]">
              <thead>
                <tr>
                  <ScanSortHeader label="Ticker" sortId="ticker" className="pl-3.5" />
                  <th>Name</th>
                  <th className="n">Price</th>
                  <ScanSortHeader label="Composite" sortId="composite" className="n" />
                  <ScanSortHeader label="Improving" sortId="improving" className="n" />
                  <th>Trend</th>
                  <ScanSortHeader label="RSI" sortId="rsi" />
                  <th>MACD</th>
                  <th>Ichimoku</th>
                  <th>Volume</th>
                  <th>52W</th>
                  <ScanSortHeader label="20d chg" sortId="momentum" className="n" />
                  <th className="pr-3.5"></th>
                </tr>
              </thead>
              <tbody>
                {filteredScanResults.map((r) => {
                  const t = r.technicals;
                  const isAdded = addedTickers.has(r.ticker) || existingTickers.includes(r.ticker.replace(".TO", ""));
                  const composite = compositeTechnicalScore(t);
                  return (
                    <tr key={r.ticker} className="cursor-pointer"
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
                      <td className="pl-3.5 font-mono font-medium text-ink">{displayTicker(r.ticker)}</td>
                      <td className="max-w-[160px] truncate text-[12px] text-ink-3">
                        {r.name && r.name !== r.ticker ? r.name : ""}
                        {r.sector && <span className="ml-1.5 text-[11px] text-ink-faint">{r.sector}</span>}
                      </td>
                      <td className="n text-ink-2">${r.price.toFixed(2)}</td>
                      <td className="n">
                        <span className="inline-flex items-center gap-2">
                          <CompositeBar bullish={composite.bullish} bearish={composite.bearish} neutral={composite.neutral} />
                          <span className={`font-medium ${compositeCls(composite.net)}`}>{composite.net > 0 ? "+" : ""}{composite.net}</span>
                        </span>
                      </td>
                      <td className="n">
                        <span className="inline-flex items-center gap-2">
                          <ImprovingBar score={r.improving.score} />
                          <span className={r.improving.score >= 2 ? "font-medium text-ink" : "text-ink-3"}>{r.improving.score}<span className="text-ink-faint">/6</span></span>
                        </span>
                      </td>
                      <td><Sig signal={getTrendSignal(t)}>{t.dmaSignal.replace(/_/g, " ")}</Sig></td>
                      <td><Sig signal={getRsiSignal(t)}><span className={`font-mono ${t.rsi14 > 70 ? "text-neg" : t.rsi14 < 30 ? "text-pos" : ""}`}>{t.rsi14.toFixed(0)}</span></Sig></td>
                      <td><Sig signal={getMacdSignal(t)}><span className={`font-mono ${t.macdHistogram >= 0 ? "text-pos" : "text-neg"}`}>{t.macdHistogram >= 0 ? "+" : ""}{t.macdHistogram.toFixed(2)}</span></Sig></td>
                      <td><Sig signal={getIchimokuSignal(t)}>{t.ichimoku.overallSignal.replace(/_/g, " ")}</Sig></td>
                      <td><Sig signal={getVolumeSignal(t)}><span className="font-mono">{t.volumeRatio.toFixed(1)}x</span></Sig></td>
                      <td><Sig signal={getWeek52Signal(t)}><span className="font-mono">{(t.week52Position * 100).toFixed(0)}%</span></Sig></td>
                      <td className={`n ${r.priceChange20d >= 0 ? "text-pos" : "text-neg"}`}>{r.priceChange20d >= 0 ? "+" : ""}{r.priceChange20d.toFixed(1)}%</td>
                      <td className="pr-3.5 text-right" onClick={(e) => e.stopPropagation()}>
                        {isAdded ? (
                          <span className="text-[11.5px] text-ink-3">Added</span>
                        ) : (
                          <button onClick={() => handleAddToWatchlist(r)} className={BTN22}>
                            <AppIcon name="plus" size={11} strokeWidth={2.25} /> Watchlist
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
          <EmptyState className="!py-8" glyph={<AppIcon name="play" size={18} />} title="No scan yet" body="Pick a universe and a minimum improving score, then run a scan to find stocks with improving technical signals." />
        )}

        {!scanning && scanResults.length === 0 && scanMeta && (
          <EmptyState className="!py-8" glyph={<AppIcon name="search" size={18} />} title="No stocks found" body={`Nothing scored an improving score of ${minImprovingScore} or more. Try lowering the minimum score.`} />
        )}
      </section>
    </div>
  );
}
