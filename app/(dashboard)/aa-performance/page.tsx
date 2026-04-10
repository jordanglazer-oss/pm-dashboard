"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import Link from "next/link";
import { ImageUpload, type BriefAttachment } from "@/app/components/ImageUpload";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import type { PimPerformanceData } from "@/app/lib/pim-types";

/* ─── Types ─── */
type AllocationRow = {
  fixedIncome: number;
  equity: number;
  alternatives: number;
};

type AllocationTable = {
  current: AllocationRow;
  target: AllocationRow;
  min: AllocationRow;
  max: AllocationRow;
};

type FundRow = {
  name: string;
  ticker: string;
  ytd: number | null;
  "1y": number | null;
  "3y": number | null;
  "5y": number | null;
  "10y": number | null;
};

type AAPerformanceData = {
  allocations: {
    balanced: AllocationTable;
    growth: AllocationTable;
    allEquity: AllocationTable;
  };
  funds: FundRow[];
  fundsDate: string;
  etfs: FundRow[];
  etfsDate: string;
  attachments: BriefAttachment[];
};

type PeriodKey = "ytd" | "1d" | "1w" | "1m" | "3m" | "6m" | "1y" | "2y" | "3y" | "5y";

const PERIOD_COLS: { key: PeriodKey; label: string }[] = [
  { key: "ytd", label: "YTD" },
  { key: "1d", label: "1D" },
  { key: "1w", label: "1W" },
  { key: "1m", label: "1M" },
  { key: "3m", label: "3M" },
  { key: "6m", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "2y", label: "2Y" },
  { key: "3y", label: "3Y" },
  { key: "5y", label: "5Y" },
];

type AutoPerfRow = { name: string } & Record<PeriodKey, number | null>;

type IndexHistoryEntry = { key: string; label: string; symbol: string; history: { date: string; close: number }[] };

const FUND_COLS: { key: keyof FundRow; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "ticker", label: "Code/Ticker" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1Y" },
  { key: "3y", label: "3Y" },
  { key: "5y", label: "5Y" },
  { key: "10y", label: "10Y" },
];

const AA_ROWS: { key: keyof AllocationTable; label: string }[] = [
  { key: "current", label: "Current" },
  { key: "target", label: "Target" },
  { key: "min", label: "Min" },
  { key: "max", label: "Max" },
];

const AA_COLS: { key: keyof AllocationRow; label: string }[] = [
  { key: "fixedIncome", label: "Fixed Income" },
  { key: "equity", label: "Equity" },
  { key: "alternatives", label: "Alternatives" },
];

/* ─── Default Data ─── */
const defaultData: AAPerformanceData = {
  allocations: {
    balanced: {
      current: { fixedIncome: 28, equity: 66, alternatives: 6 },
      target: { fixedIncome: 40, equity: 55, alternatives: 0 },
      min: { fixedIncome: 20, equity: 40, alternatives: 0 },
      max: { fixedIncome: 60, equity: 70, alternatives: 25 },
    },
    growth: {
      current: { fixedIncome: 14, equity: 83, alternatives: 3 },
      target: { fixedIncome: 25, equity: 70, alternatives: 0 },
      min: { fixedIncome: 10, equity: 55, alternatives: 0 },
      max: { fixedIncome: 40, equity: 90, alternatives: 25 },
    },
    allEquity: {
      current: { fixedIncome: 0, equity: 99, alternatives: 0 },
      target: { fixedIncome: 0, equity: 95, alternatives: 0 },
      min: { fixedIncome: 0, equity: 75, alternatives: 0 },
      max: { fixedIncome: 25, equity: 100, alternatives: 25 },
    },
  },
  funds: [
    { name: "RBC Core Plus Bond Pool (USD)", ticker: "", ytd: -0.07, "1y": 6.20, "3y": 5.98, "5y": 1.63, "10y": null },
    { name: "Dynamic Power American Growth (USD)", ticker: "", ytd: -13.16, "1y": 19.54, "3y": 20.00, "5y": -0.81, "10y": 14.00 },
    { name: "Fidelity Global Innovators Class", ticker: "", ytd: 1.67, "1y": 33.63, "3y": 37.84, "5y": 15.24, "10y": null },
    { name: "Dynamic Premium Yield Plus", ticker: "", ytd: -1.33, "1y": 16.11, "3y": 14.28, "5y": 11.50, "10y": null },
  ],
  fundsDate: "03/26/2026",
  etfs: [
    { name: "iShares US Small Cap Index (XSU)", ticker: "XSU", ytd: 5.32, "1y": 13.69, "3y": 10.13, "5y": 4.49, "10y": 9.37 },
    { name: "JP Morgan Active Bond ETF (JBND)", ticker: "JBND", ytd: -0.05, "1y": 5.96, "3y": null, "5y": null, "10y": null },
  ],
  etfsDate: "03/26/2026",
  attachments: [],
};

/* ─── NumericInput (same pattern as MorningBrief) ─── */
function NumericInput({
  value,
  onChange,
  className = "",
  placeholder,
}: {
  value: number | null;
  onChange: (n: number | null) => void;
  className?: string;
  placeholder?: string;
}) {
  const [focused, setFocused] = useState(false);
  const [text, setText] = useState(value === null ? "" : String(value));

  useEffect(() => {
    if (!focused) setText(value === null ? "" : String(value));
  }, [value, focused]);

  function commit(raw: string) {
    if (raw.trim() === "") {
      onChange(null);
      return;
    }
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(n);
    else setText(value === null ? "" : String(value));
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={focused ? text : (value === null ? "" : String(value))}
      placeholder={placeholder}
      onFocus={() => { setFocused(true); setText(value === null ? "" : String(value)); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { commit(e.target.value); setFocused(false); }}
      onKeyDown={(e) => { if (e.key === "Enter") { commit(text); (e.target as HTMLInputElement).blur(); } }}
      className={className}
    />
  );
}

/* ─── Debounced persist ─── */
function useDebouncedPersist(delay = 500) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  return useCallback(
    (data: AAPerformanceData) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        fetch("/api/kv/aa-performance", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ aaPerformance: data }),
        }).catch((e) => console.error("Failed to persist aa-performance:", e));
      }, delay);
    },
    [delay]
  );
}

/* ─── Asset Allocation Table Component ─── */
function AllocationTableCard({
  title,
  table,
  onUpdate,
}: {
  title: string;
  table: AllocationTable;
  onUpdate: (rowKey: keyof AllocationTable, colKey: keyof AllocationRow, value: number) => void;
}) {
  return (
    <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-100">
        <h3 className="text-base font-bold text-slate-800">{title}</h3>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100">
              <th className="px-4 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider w-24"></th>
              {AA_COLS.map((col) => (
                <th key={col.key} className="px-4 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AA_ROWS.map((row) => {
              const isCurrent = row.key === "current";
              return (
                <tr
                  key={row.key}
                  className={`border-b border-slate-50 ${isCurrent ? "bg-emerald-50" : "hover:bg-slate-50"}`}
                >
                  <td className={`px-4 py-2 text-xs font-semibold ${isCurrent ? "text-emerald-700" : "text-slate-600"}`}>
                    {row.label}
                  </td>
                  {AA_COLS.map((col) => (
                    <td key={col.key} className="px-2 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <NumericInput
                          value={table[row.key][col.key]}
                          onChange={(n) => onUpdate(row.key, col.key, n ?? 0)}
                          className={`w-16 rounded-lg border px-2 py-1 text-sm text-center font-medium ${
                            isCurrent
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                              : "border-slate-200 bg-white text-slate-700"
                          } focus:outline-none focus:ring-1 focus:ring-blue-200`}
                        />
                        <span className="text-xs text-slate-400">%</span>
                      </div>
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Active Funds / ETFs Table ─── */
function FundsTable({
  title,
  dateValue,
  onDateChange,
  rows,
  onUpdateRow,
  onAddRow,
  onRemoveRow,
}: {
  title: string;
  dateValue: string;
  onDateChange: (v: string) => void;
  rows: FundRow[];
  onUpdateRow: (idx: number, key: string, value: string | number | null) => void;
  onAddRow: () => void;
  onRemoveRow: (idx: number) => void;
}) {
  const [editingDate, setEditingDate] = useState(false);
  const [tempDate, setTempDate] = useState(dateValue);

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold text-slate-700">{title} (as of </span>
        {editingDate ? (
          <input
            autoFocus
            value={tempDate}
            onChange={(e) => setTempDate(e.target.value)}
            onBlur={() => { onDateChange(tempDate); setEditingDate(false); }}
            onKeyDown={(e) => { if (e.key === "Enter") { onDateChange(tempDate); setEditingDate(false); } if (e.key === "Escape") setEditingDate(false); }}
            className="w-28 bg-white border border-blue-300 focus:ring-1 focus:ring-blue-200 rounded-lg outline-none transition-all px-1 py-0.5 text-sm"
          />
        ) : (
          <span
            onClick={() => { setTempDate(dateValue); setEditingDate(true); }}
            className="text-sm font-bold text-slate-700 cursor-pointer hover:bg-blue-50 rounded px-1 py-0.5"
            title="Click to edit date"
          >
            {dateValue}
          </span>
        )}
        <span className="text-sm font-bold text-slate-700">)</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              {FUND_COLS.map((col) => (
                <th
                  key={col.key}
                  className={`px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider ${
                    col.key === "name" ? "text-left min-w-[220px]" : col.key === "ticker" ? "text-left min-w-[100px]" : "text-center"
                  }`}
                >
                  {col.label}
                </th>
              ))}
              <th className="px-2 py-2.5 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-50 hover:bg-slate-50/50">
                <td className="px-3 py-1.5">
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => onUpdateRow(rowIdx, "name", e.target.value)}
                    className="w-full rounded-lg border border-transparent px-2 py-1 text-sm font-medium text-slate-800 hover:border-slate-200 hover:bg-slate-50 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-transparent"
                  />
                </td>
                <td className="px-3 py-1.5">
                  <input
                    type="text"
                    value={row.ticker}
                    onChange={(e) => onUpdateRow(rowIdx, "ticker", e.target.value)}
                    className="w-full rounded-lg border border-transparent px-2 py-1 text-sm font-mono text-slate-700 hover:border-slate-200 hover:bg-slate-50 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-transparent"
                    placeholder="—"
                  />
                </td>
                {FUND_COLS.filter((c) => c.key !== "name" && c.key !== "ticker").map((col) => {
                  const val = row[col.key] as number | null;
                  return (
                    <td key={col.key} className="px-1 py-1.5 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <NumericInput
                          value={val}
                          onChange={(n) => onUpdateRow(rowIdx, col.key, n)}
                          placeholder="—"
                          className={`w-16 rounded-lg border border-transparent px-1 py-1 text-sm text-center font-medium ${
                            val === null ? "text-slate-400" : val < 0 ? "text-red-600" : val > 0 ? "text-emerald-600" : "text-slate-600"
                          } hover:border-slate-200 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-slate-50/50 hover:bg-white`}
                        />
                        {val !== null && <span className="text-[10px] text-slate-400">%</span>}
                      </div>
                    </td>
                  );
                })}
                <td className="px-2 py-1.5 text-center">
                  <button onClick={() => onRemoveRow(rowIdx)} className="text-slate-300 hover:text-red-500 font-bold transition-colors" title="Remove">&times;</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={onAddRow}
        className="mt-2 rounded-xl bg-blue-600 px-5 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
      >
        Add
      </button>
    </div>
  );
}

/* ─── Format helper for performance values ─── */
function formatPerf(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(2);
}

function perfColor(v: number | null): string {
  if (v === null) return "text-slate-400";
  return v < 0 ? "text-red-600" : v > 0 ? "text-emerald-600" : "text-slate-600";
}

/* ─── Auto-populated Funds / ETFs Table (from portfolio) ─── */
function AutoFundsTable({
  title,
  holdings,
}: {
  title: string;
  holdings: { ticker: string; name: string; instrumentType?: string; fundData?: { performance?: { ytd?: number; oneYear?: number; threeYear?: number; fiveYear?: number; tenYear?: number }; lastUpdated?: string } }[];
}) {
  // Find the most recent lastUpdated across all holdings
  const lastUpdated = holdings.reduce((latest, h) => {
    const d = h.fundData?.lastUpdated;
    if (!d) return latest;
    return !latest || d > latest ? d : latest;
  }, "" as string);

  const dateLabel = lastUpdated
    ? new Date(lastUpdated).toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" })
    : "";

  return (
    <div className="mb-6">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold text-slate-700">{title}</span>
        {dateLabel && <span className="text-xs text-slate-400">(as of {dateLabel})</span>}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50/50">
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider min-w-[220px]">Name</th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider min-w-[100px]">Code/Ticker</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">YTD</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">1Y</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">3Y</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">5Y</th>
              <th className="px-3 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider">10Y</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const perf = h.fundData?.performance;
              return (
                <tr key={h.ticker} className="border-b border-slate-50 hover:bg-slate-50/50">
                  <td className="px-3 py-2.5">
                    <Link href={`/stock/${h.ticker.toLowerCase()}`} className="text-sm font-medium text-slate-800 hover:underline">
                      {h.name || h.ticker}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-sm font-mono text-slate-600">{h.ticker}</td>
                  <td className={`px-3 py-2.5 text-center text-sm font-medium ${perfColor(perf?.ytd ?? null)}`}>
                    {formatPerf(perf?.ytd ?? null)}{perf?.ytd != null && <span className="text-[10px] text-slate-400 ml-0.5">%</span>}
                  </td>
                  <td className={`px-3 py-2.5 text-center text-sm font-medium ${perfColor(perf?.oneYear ?? null)}`}>
                    {formatPerf(perf?.oneYear ?? null)}{perf?.oneYear != null && <span className="text-[10px] text-slate-400 ml-0.5">%</span>}
                  </td>
                  <td className={`px-3 py-2.5 text-center text-sm font-medium ${perfColor(perf?.threeYear ?? null)}`}>
                    {formatPerf(perf?.threeYear ?? null)}{perf?.threeYear != null && <span className="text-[10px] text-slate-400 ml-0.5">%</span>}
                  </td>
                  <td className={`px-3 py-2.5 text-center text-sm font-medium ${perfColor(perf?.fiveYear ?? null)}`}>
                    {formatPerf(perf?.fiveYear ?? null)}{perf?.fiveYear != null && <span className="text-[10px] text-slate-400 ml-0.5">%</span>}
                  </td>
                  <td className={`px-3 py-2.5 text-center text-sm font-medium ${perfColor(perf?.tenYear ?? null)}`}>
                    {formatPerf(perf?.tenYear ?? null)}{perf?.tenYear != null && <span className="text-[10px] text-slate-400 ml-0.5">%</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Period Return Helpers ─── */
type ValuePoint = { date: string; value: number };

/** Find the last entry on or before the target date. Assumes history is sorted ascending by date. */
function findEntryOnOrBefore(history: ValuePoint[], targetDate: string): ValuePoint | null {
  let result: ValuePoint | null = null;
  for (const e of history) {
    if (e.date <= targetDate) result = e;
    else break;
  }
  return result;
}

/** Subtract a number of calendar days/months/years from today and return YYYY-MM-DD. */
function dateOffset(opts: { days?: number; months?: number; years?: number }): string {
  const d = new Date();
  if (opts.days) d.setDate(d.getDate() - opts.days);
  if (opts.months) d.setMonth(d.getMonth() - opts.months);
  if (opts.years) d.setFullYear(d.getFullYear() - opts.years);
  return d.toISOString().split("T")[0];
}

/**
 * Compute period returns for a value-history series.
 * Returns null for any period that the history doesn't cover.
 *
 * - 1D = last entry vs second-to-last entry (most recent close-to-close)
 * - 1W..5Y = last entry vs the entry on or before today minus that period
 * - YTD = last entry vs the last entry of the prior calendar year
 */
function computePeriodReturns(history: ValuePoint[]): Record<PeriodKey, number | null> {
  const empty: Record<PeriodKey, number | null> = {
    ytd: null, "1d": null, "1w": null, "1m": null, "3m": null,
    "6m": null, "1y": null, "2y": null, "3y": null, "5y": null,
  };
  if (history.length < 2) return empty;
  const last = history[history.length - 1];
  if (!last.value || last.value <= 0) return empty;

  const pct = (start: ValuePoint | null): number | null => {
    if (!start || !start.value || start.value <= 0) return null;
    return parseFloat((((last.value / start.value) - 1) * 100).toFixed(2));
  };

  // 1D: last vs previous entry
  const prev = history[history.length - 2];
  const d1: number | null = prev ? pct(prev) : null;

  // YTD: last entry of prior calendar year (Dec 31). Falls back to null
  // if the series doesn't extend into the prior year.
  const currentYear = new Date().getFullYear();
  const ytdCutoff = `${currentYear}-01-01`;
  let ytdBaseline: ValuePoint | null = null;
  for (const e of history) {
    if (e.date < ytdCutoff) ytdBaseline = e;
    else break;
  }
  const ytd = pct(ytdBaseline);

  return {
    ytd,
    "1d": d1,
    "1w": pct(findEntryOnOrBefore(history, dateOffset({ days: 7 }))),
    "1m": pct(findEntryOnOrBefore(history, dateOffset({ months: 1 }))),
    "3m": pct(findEntryOnOrBefore(history, dateOffset({ months: 3 }))),
    "6m": pct(findEntryOnOrBefore(history, dateOffset({ months: 6 }))),
    "1y": pct(findEntryOnOrBefore(history, dateOffset({ years: 1 }))),
    "2y": pct(findEntryOnOrBefore(history, dateOffset({ years: 2 }))),
    "3y": pct(findEntryOnOrBefore(history, dateOffset({ years: 3 }))),
    "5y": pct(findEntryOnOrBefore(history, dateOffset({ years: 5 }))),
  };
}

/* ─── Main Page ─── */
export default function AAPerformancePage() {
  const [data, setData] = useState<AAPerformanceData>(defaultData);
  const [loading, setLoading] = useState(true);
  const [pimData, setPimData] = useState<PimPerformanceData | null>(null);
  const [pimLoading, setPimLoading] = useState(false);
  const [indexes, setIndexes] = useState<IndexHistoryEntry[]>([]);
  // Start as loading so the "refreshing…" indicator shows on first paint
  // without needing to call setState inside the effect (which lint flags
  // as a cascading-render anti-pattern).
  const [indexLoading, setIndexLoading] = useState(true);
  const persist = useDebouncedPersist(500);
  const { scoredStocks } = useStocks();

  // Derive funds and ETFs from portfolio holdings
  const portfolioFunds = scoredStocks.filter((s) => s.bucket === "Portfolio" && !isScoreable(s));
  const mutualFunds = portfolioFunds.filter((s) => s.instrumentType === "mutual-fund");
  const etfs = portfolioFunds.filter((s) => s.instrumentType === "etf");

  /* Load from KV on mount */
  useEffect(() => {
    fetch("/api/kv/aa-performance")
      .then((r) => r.json())
      .then((res) => {
        if (res.aaPerformance) {
          // Merge with defaults so new fields are always present.
          // Strip legacy fields (`performance`, `pimMappings`) — those rows
          // are now auto-computed from PIM data and the index endpoint.
          const { performance: _p, pimMappings: _m, ...rest } = res.aaPerformance;
          void _p; void _m;
          setData({
            ...defaultData,
            ...rest,
            allocations: {
              ...defaultData.allocations,
              ...(res.aaPerformance.allocations || {}),
            },
          });
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  /* Fetch PIM performance data on mount */
  useEffect(() => {
    setPimLoading(true);
    fetch("/api/pim-performance", { method: "POST" })
      .then((r) => r.json())
      .then((res) => {
        if (res.models) setPimData(res as PimPerformanceData);
        setPimLoading(false);
      })
      .catch(() => setPimLoading(false));
  }, []);

  /* Fetch index histories (S&P 500, S&P/TSX) on mount */
  useEffect(() => {
    fetch("/api/index-history")
      .then((r) => r.json())
      .then((res) => {
        if (Array.isArray(res?.indexes)) setIndexes(res.indexes as IndexHistoryEntry[]);
      })
      .catch(() => {})
      .finally(() => setIndexLoading(false));
  }, []);

  /* Update helper that persists */
  const updateData = useCallback(
    (updater: (prev: AAPerformanceData) => AAPerformanceData) => {
      setData((prev) => {
        const next = updater(prev);
        persist(next);
        return next;
      });
    },
    [persist]
  );

  /* Allocation update */
  const updateAllocation = useCallback(
    (
      tableKey: "balanced" | "growth" | "allEquity",
      rowKey: keyof AllocationTable,
      colKey: keyof AllocationRow,
      value: number
    ) => {
      updateData((prev) => ({
        ...prev,
        allocations: {
          ...prev.allocations,
          [tableKey]: {
            ...prev.allocations[tableKey],
            [rowKey]: {
              ...prev.allocations[tableKey][rowKey],
              [colKey]: value,
            },
          },
        },
      }));
    },
    [updateData]
  );

  /* Funds / ETFs helpers */
  const updateFundRow = useCallback(
    (table: "funds" | "etfs", rowIdx: number, key: string, value: string | number | null) => {
      updateData((prev) => ({
        ...prev,
        [table]: (prev[table] || []).map((row: FundRow, i: number) =>
          i === rowIdx ? { ...row, [key]: value } : row
        ),
      }));
    },
    [updateData]
  );

  const addFundRow = useCallback(
    (table: "funds" | "etfs") => {
      updateData((prev) => ({
        ...prev,
        [table]: [...(prev[table] || []), { name: "", ticker: "", ytd: null, "1y": null, "3y": null, "5y": null, "10y": null }],
      }));
    },
    [updateData]
  );

  const removeFundRow = useCallback(
    (table: "funds" | "etfs", idx: number) => {
      updateData((prev) => ({
        ...prev,
        [table]: (prev[table] || []).filter((_: FundRow, i: number) => i !== idx),
      }));
    },
    [updateData]
  );

  const updateFundsDate = useCallback(
    (key: "fundsDate" | "etfsDate", value: string) => {
      updateData((prev) => ({ ...prev, [key]: value }));
    },
    [updateData]
  );

  /* Attachment handlers */
  const addAttachment = useCallback(
    (att: BriefAttachment) => {
      updateData((prev) => ({
        ...prev,
        attachments: [...(prev.attachments || []), att],
      }));
    },
    [updateData]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      updateData((prev) => ({
        ...prev,
        attachments: (prev.attachments || []).filter((a) => a.id !== id),
      }));
    },
    [updateData]
  );

  /* ─── Auto-computed Performance rows ─── */
  // Builds a fixed set of rows from PIM model histories and live index data:
  //   • PIM Balanced / Growth / All-Equity / Alpha — pulled straight from
  //     the same `pim-performance` data the PIM Model page renders, so the
  //     numbers stay in sync with that screen.
  //   • S&P 500 / S&P/TSX Composite — pulled from /api/index-history (Yahoo
  //     ^GSPC and ^GSPTSE).
  // Period returns for both are computed from the same value-history series
  // so the methodology is identical across rows.
  const autoPerformanceRows = useMemo<AutoPerfRow[]>(() => {
    const rows: AutoPerfRow[] = [];

    const pimProfiles: { profile: "balanced" | "growth" | "allEquity" | "alpha"; label: string }[] = [
      { profile: "balanced", label: "PIM Balanced" },
      { profile: "growth", label: "PIM Growth" },
      { profile: "allEquity", label: "PIM All-Equity" },
      { profile: "alpha", label: "PIM Alpha" },
    ];
    for (const p of pimProfiles) {
      const model = pimData?.models.find(
        (m) => m.groupId === "pim" && m.profile === p.profile
      );
      const history: ValuePoint[] = model
        ? model.history.map((h) => ({ date: h.date, value: h.value }))
        : [];
      rows.push({ name: p.label, ...computePeriodReturns(history) });
    }

    for (const idx of indexes) {
      const history: ValuePoint[] = idx.history.map((b) => ({ date: b.date, value: b.close }));
      rows.push({ name: idx.label, ...computePeriodReturns(history) });
    }

    return rows;
  }, [pimData, indexes]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-pulse text-slate-400 text-lg">Loading AA & Performance...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8 pb-12">
      {/* ── Asset Allocation Section ── */}
      <section>
        <h2 className="text-xl font-bold text-slate-800 mb-4">Asset Allocation</h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <AllocationTableCard
            title="Balanced"
            table={data.allocations.balanced}
            onUpdate={(rowKey, colKey, value) => updateAllocation("balanced", rowKey, colKey, value)}
          />
          <AllocationTableCard
            title="Growth"
            table={data.allocations.growth}
            onUpdate={(rowKey, colKey, value) => updateAllocation("growth", rowKey, colKey, value)}
          />
          <AllocationTableCard
            title="All-Equity"
            table={data.allocations.allEquity}
            onUpdate={(rowKey, colKey, value) => updateAllocation("allEquity", rowKey, colKey, value)}
          />
        </div>
      </section>

      {/* ── Performance Section ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-xl font-bold text-slate-800">Performance</h2>
          {(pimLoading || indexLoading) && (
            <span className="text-xs text-slate-400 animate-pulse">refreshing…</span>
          )}
        </div>
        <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  <th className="px-3 py-2.5 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider min-w-[220px]">
                    Name
                  </th>
                  {PERIOD_COLS.map((col) => (
                    <th
                      key={col.key}
                      className="px-3 py-2.5 text-center text-xs font-semibold text-slate-500 uppercase tracking-wider"
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {autoPerformanceRows.map((row) => (
                  <tr key={row.name} className="border-b border-slate-50 hover:bg-slate-50/50">
                    <td className="px-3 py-2.5 text-sm font-medium text-slate-800">{row.name}</td>
                    {PERIOD_COLS.map((col) => {
                      const val = row[col.key];
                      return (
                        <td
                          key={col.key}
                          className={`px-3 py-2.5 text-center text-sm font-medium ${perfColor(val)}`}
                        >
                          {formatPerf(val)}
                          {val !== null && <span className="text-[10px] text-slate-400 ml-0.5">%</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Active Funds / ETFs Section (auto-populated from portfolio) ── */}
      <section>
        <h2 className="text-xl font-bold text-slate-800 mb-4">Active Funds / ETFs</h2>
        <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
          {portfolioFunds.length === 0 ? (
            <p className="text-sm text-slate-400">No funds or ETFs in your portfolio. Add them from the <Link href="/" className="text-blue-600 hover:underline">Dashboard</Link>.</p>
          ) : (
            <>
              {mutualFunds.length > 0 && (
                <AutoFundsTable title="Funds" holdings={mutualFunds} />
              )}
              {etfs.length > 0 && (
                <AutoFundsTable title="ETFs" holdings={etfs} />
              )}
            </>
          )}
        </div>
      </section>

      {/* ── Alpha Sleeve Analysis Section ── */}
      <section>
        <h2 className="text-xl font-bold text-slate-800 mb-4">Alpha Sleeve Analysis</h2>
        <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
          <ImageUpload
            section="aa-performance"
            sectionLabel="Alpha Sleeve Analysis"
            attachments={data.attachments || []}
            onAdd={addAttachment}
            onRemove={removeAttachment}
          />
        </div>
      </section>

      {/* ── Boosted.AI ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-xl font-bold text-slate-800">Boosted.AI</h2>
          <a href="https://insights.boosted.ai/dashboard/ideas/de0064ab-7a78-4103-994c-3ad9d15e8211" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 text-sm font-medium flex items-center gap-1">
            Open <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
          </a>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
            <h3 className="text-base font-bold text-slate-700 mb-2">Portfolio Holdings</h3>
            <ImageUpload
              section="boosted-holdings"
              sectionLabel="Portfolio Holdings"
              attachments={data.attachments || []}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
          </div>
          <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
            <h3 className="text-base font-bold text-slate-700 mb-2">Sector Performance</h3>
            <ImageUpload
              section="boosted-sector"
              sectionLabel="Sector Performance"
              attachments={data.attachments || []}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
          </div>
        </div>
      </section>

      {/* ── SIA ── */}
      <section>
        <div className="flex items-center gap-2 mb-4">
          <h2 className="text-xl font-bold text-slate-800">SIA</h2>
          <a href="https://www2.siacharts.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700 text-sm font-medium flex items-center gap-1">
            Open <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
          </a>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
            <h3 className="text-base font-bold text-slate-700 mb-2">Portfolio Holdings</h3>
            <ImageUpload
              section="sia-holdings"
              sectionLabel="Portfolio Holdings"
              attachments={data.attachments || []}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
          </div>
          <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
            <h3 className="text-base font-bold text-slate-700 mb-2">Equity Action Call</h3>
            <ImageUpload
              section="sia-equity-action"
              sectionLabel="Equity Action Call"
              attachments={data.attachments || []}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
          </div>
          <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
            <h3 className="text-base font-bold text-slate-700 mb-2">Asset Class Rankings</h3>
            <ImageUpload
              section="sia-asset-class"
              sectionLabel="Asset Class Rankings"
              attachments={data.attachments || []}
              onAdd={addAttachment}
              onRemove={removeAttachment}
            />
          </div>
        </div>
      </section>

      {/* ── Seeking Alpha ── */}
      <section>
        <h2 className="text-xl font-bold text-slate-800 mb-4">Seeking Alpha</h2>
        <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm p-6">
          <ImageUpload
            section="seeking-alpha-aa"
            sectionLabel="Seeking Alpha"
            attachments={data.attachments || []}
            onAdd={addAttachment}
            onRemove={removeAttachment}
          />
        </div>
      </section>
    </div>
  );
}
