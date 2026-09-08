"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Attribution } from "@/app/components/Attribution";
import Link from "next/link";
import { ImageUpload, type BriefAttachment } from "@/app/components/ImageUpload";
import { SkeletonTable } from "@/app/components/Skeleton";
import { AppIcon } from "@/app/components/AppIcon";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import type { AppendixData, PimPerformanceData, PimProfileWeights } from "@/app/lib/pim-types";
import { useLiveTodayReturn } from "@/app/lib/useLiveTodayReturn";
import { getTodayET } from "@/app/lib/market-hours";

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
    conservative: AllocationTable;
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

// `annualized` means the column shows CAGR (annualized return) instead of
// the raw cumulative return over the window. We annualize anything ≥ 1Y so
// the table is comparable across periods at a glance.
const PERIOD_COLS: { key: PeriodKey; label: string; annualized: boolean }[] = [
  { key: "ytd", label: "YTD", annualized: false },
  { key: "1d", label: "1D", annualized: false },
  { key: "1w", label: "1W", annualized: false },
  { key: "1m", label: "1M", annualized: false },
  { key: "3m", label: "3M", annualized: false },
  { key: "6m", label: "6M", annualized: false },
  { key: "1y", label: "1Y", annualized: true },
  { key: "2y", label: "2Y", annualized: true },
  { key: "3y", label: "3Y", annualized: true },
  { key: "5y", label: "5Y", annualized: true },
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

// Short column labels keep the four profile cards narrow enough to sit
// side-by-side without spilling off the page. "Fixed Inc." / "Alts" are
// unambiguous in an asset-allocation context.
const AA_COLS: { key: keyof AllocationRow; label: string }[] = [
  { key: "fixedIncome", label: "Fixed Inc." },
  { key: "equity", label: "Equity" },
  { key: "alternatives", label: "Alts" },
];

/* ─── Default Data ─── */
const defaultData: AAPerformanceData = {
  allocations: {
    conservative: {
      current: { fixedIncome: 64, equity: 30, alternatives: 6 },
      target: { fixedIncome: 60, equity: 35, alternatives: 0 },
      min: { fixedIncome: 40, equity: 20, alternatives: 0 },
      max: { fixedIncome: 75, equity: 45, alternatives: 25 },
    },
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
    // Sync the editable text with the prop when not actively editing — an
    // intentional controlled-input pattern.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

/* ─── Asset Allocation profile editor (one cell of the allocation panel) ─── */
function AllocationEditor({
  title,
  table,
  onUpdate,
}: {
  title: string;
  table: AllocationTable;
  onUpdate: (rowKey: keyof AllocationTable, colKey: keyof AllocationRow, value: number) => void;
}) {
  return (
    <div className="min-w-0 px-3.5 py-3">
      <div className="text-[13px] font-semibold text-ink">{title}</div>
      <div className="mt-2 max-w-full overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr>
              <th className="w-12 pb-1 text-left text-[11px] font-normal text-ink-3"></th>
              {AA_COLS.map((col) => (
                <th key={col.key} className="pb-1 text-center text-[11px] font-normal text-ink-3">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AA_ROWS.map((row) => {
              const isCurrent = row.key === "current";
              return (
                <tr key={row.key}>
                  <td className={`py-0.5 pr-1 text-[11px] ${isCurrent ? "text-pos" : "text-ink-3"}`}>
                    {row.label}
                  </td>
                  {AA_COLS.map((col) => (
                    <td key={col.key} className="px-0.5 py-0.5 text-center">
                      <div className="flex items-center justify-center gap-0.5">
                        <NumericInput
                          value={table[row.key][col.key]}
                          onChange={(n) => onUpdate(row.key, col.key, n ?? 0)}
                          className={`h-7 w-12 rounded-control border bg-surface px-1 text-center font-mono text-[12.5px] tabular-nums outline-none focus:border-accent-border ${
                            isCurrent ? "border-pos-border text-pos" : "border-line text-ink"
                          }`}
                        />
                        <span className="text-[11px] text-ink-3">%</span>
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

/* ─── Active Funds / ETFs Table (manual entry; kept for the editable path) ─── */
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
    <section className="panel">
      <div className="panel-h flex-wrap py-1.5">
        <span className="t">{title}</span>
        <span className="m flex items-center gap-1">
          as of
          {editingDate ? (
            <input
              autoFocus
              value={tempDate}
              onChange={(e) => setTempDate(e.target.value)}
              onBlur={() => { onDateChange(tempDate); setEditingDate(false); }}
              onKeyDown={(e) => { if (e.key === "Enter") { onDateChange(tempDate); setEditingDate(false); } if (e.key === "Escape") setEditingDate(false); }}
              className="h-7 w-28 rounded-control border border-line bg-surface px-2 text-[12.5px] outline-none focus:border-accent-border"
            />
          ) : (
            <button
              onClick={() => { setTempDate(dateValue); setEditingDate(true); }}
              className="font-mono text-ink-2 hover:text-ink"
              title="Click to edit date"
            >
              {dateValue}
            </button>
          )}
        </span>
        <button
          onClick={onAddRow}
          className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium !text-white hover:bg-ink-2"
        >
          <AppIcon name="plus" size={13} /> Add row
        </button>
      </div>
      <div className="max-w-full overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              {FUND_COLS.map((col) => (
                <th
                  key={col.key}
                  className={col.key === "name" ? "min-w-[220px] pl-3.5" : col.key === "ticker" ? "min-w-[100px]" : "n"}
                >
                  {col.label}
                </th>
              ))}
              <th className="w-8"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx}>
                <td className="pl-3.5">
                  <input
                    type="text"
                    value={row.name}
                    onChange={(e) => onUpdateRow(rowIdx, "name", e.target.value)}
                    className="h-7 w-full rounded-control border border-transparent bg-transparent px-2 text-[12.5px] text-ink outline-none hover:border-line focus:border-accent-border"
                  />
                </td>
                <td>
                  <input
                    type="text"
                    value={row.ticker}
                    onChange={(e) => onUpdateRow(rowIdx, "ticker", e.target.value)}
                    className="h-7 w-full rounded-control border border-transparent bg-transparent px-2 font-mono text-[12.5px] text-ink outline-none hover:border-line focus:border-accent-border"
                    placeholder="—"
                  />
                </td>
                {FUND_COLS.filter((c) => c.key !== "name" && c.key !== "ticker").map((col) => {
                  const val = row[col.key] as number | null;
                  return (
                    <td key={col.key} className="n">
                      <div className="flex items-center justify-end gap-0.5">
                        <NumericInput
                          value={val}
                          onChange={(n) => onUpdateRow(rowIdx, col.key, n)}
                          placeholder="—"
                          className={`h-7 w-16 rounded-control border border-transparent bg-transparent px-1 text-right font-mono text-[12.5px] outline-none hover:border-line focus:border-accent-border ${perfColor(val)}`}
                        />
                        {val !== null && <span className="text-[11px] text-ink-3">%</span>}
                      </div>
                    </td>
                  );
                })}
                <td className="text-center">
                  <button onClick={() => onRemoveRow(rowIdx)} className="text-ink-faint hover:text-neg" title="Remove" aria-label="Remove">
                    <AppIcon name="x" size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ─── Format helper for performance values ─── */
function formatPerf(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(2);
}

function perfColor(v: number | null): string {
  if (v === null) return "text-ink-3";
  return v < 0 ? "text-neg" : v > 0 ? "text-pos" : "text-ink-2";
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
    <section className="panel">
      <div className="panel-h flex-wrap py-1.5">
        <span className="t">{title}</span>
        {dateLabel && <span className="m">as of {dateLabel}</span>}
      </div>
      <div className="max-w-full overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="min-w-[220px] pl-3.5">Name</th>
              <th className="min-w-[100px]">Code/Ticker</th>
              <th className="n">YTD</th>
              <th className="n">1Y</th>
              <th className="n">3Y</th>
              <th className="n">5Y</th>
              <th className="n">10Y</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => {
              const perf = h.fundData?.performance;
              return (
                <tr key={h.ticker}>
                  <td className="pl-3.5">
                    <Link href={`/stock/${h.ticker.toLowerCase()}`} className="text-ink hover:text-accent">
                      {h.name || h.ticker}
                    </Link>
                  </td>
                  <td className="font-mono text-ink-2">{h.ticker}</td>
                  {([perf?.ytd, perf?.oneYear, perf?.threeYear, perf?.fiveYear, perf?.tenYear] as (number | undefined)[]).map((v, i) => (
                    <td key={i} className={`n ${perfColor(v ?? null)}`}>
                      {formatPerf(v ?? null)}{v != null && <span className="ml-0.5 text-ink-3">%</span>}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/* ─── Period Return Helpers ─── */
type ValuePoint = { date: string; value: number };

/**
 * Trading-day counts that mirror PimPerformance.tsx's PERIOD_OPTIONS so the
 * AA & Perf table matches the PIM Model page exactly. The values represent
 * the trading-day window length (e.g. 1Y = last 252 trading days — the same
 * convention used by every other PIM screen). `years` is set when the period
 * should be reported as an annualized CAGR rather than a raw cumulative
 * return; sub-1Y periods are reported as raw cumulative.
 */
const PERIOD_TRADING_DAYS: Record<
  Exclude<PeriodKey, "ytd">,
  { days: number; years: number | null }
> = {
  "1d": { days: 1, years: null },
  "1w": { days: 5, years: null },
  "1m": { days: 21, years: null },
  "3m": { days: 63, years: null },
  "6m": { days: 126, years: null },
  "1y": { days: 252, years: 1 },
  "2y": { days: 504, years: 2 },
  "3y": { days: 756, years: 3 },
  "5y": { days: 1260, years: 5 },
};

/**
 * Defensive cleanup: sort by date ascending and dedupe (keeping the last
 * value seen for any given date). The PIM performance route in some edge
 * cases emits entries that aren't strictly monotonic — this guarantees
 * downstream period math sees a clean, ordered series.
 */
function normalizeHistory(history: ValuePoint[]): ValuePoint[] {
  const seen = new Map<string, number>();
  for (const e of history) {
    if (e && e.date && typeof e.value === "number" && !isNaN(e.value)) {
      seen.set(e.date, e.value);
    }
  }
  return [...seen.entries()]
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Compute period returns for a value-history series using the same
 * trading-day-slice methodology as PimPerformance.tsx. For each period
 * we look at the entry `days` rows back from the last entry. If the
 * history doesn't span that many trading days, the period returns null
 * (rather than falling back to since-inception, which would mislabel
 * the row).
 *
 * Sub-1Y periods are reported as the raw cumulative return over the
 * window: (last/start − 1) × 100. Periods with `years` set (1Y, 2Y, 3Y,
 * 5Y) are reported as annualized CAGR: ((last/start)^(1/years) − 1) × 100.
 *
 * YTD is special-cased to use the last close of the prior calendar year
 * as the baseline (matching the Calendar Year Returns methodology on
 * the PIM Model page) and is always reported as raw cumulative.
 */
function computePeriodReturns(rawHistory: ValuePoint[]): Record<PeriodKey, number | null> {
  const empty: Record<PeriodKey, number | null> = {
    ytd: null, "1d": null, "1w": null, "1m": null, "3m": null,
    "6m": null, "1y": null, "2y": null, "3y": null, "5y": null,
  };
  const history = normalizeHistory(rawHistory);
  if (history.length < 2) return empty;
  const last = history[history.length - 1];
  if (!last.value || last.value <= 0) return empty;

  const cumulativePct = (start: ValuePoint | null): number | null => {
    if (!start || !start.value || start.value <= 0) return null;
    return parseFloat((((last.value / start.value) - 1) * 100).toFixed(2));
  };

  const annualizedPct = (start: ValuePoint | null, years: number): number | null => {
    if (!start || !start.value || start.value <= 0 || years <= 0) return null;
    return parseFloat(((Math.pow(last.value / start.value, 1 / years) - 1) * 100).toFixed(2));
  };

  const result: Record<PeriodKey, number | null> = { ...empty };

  for (const key of Object.keys(PERIOD_TRADING_DAYS) as Array<keyof typeof PERIOD_TRADING_DAYS>) {
    const { days, years } = PERIOD_TRADING_DAYS[key];
    // Need at least `days + 1` entries — one for the start, one for the
    // end, plus the days in between. Anything shorter means the history
    // doesn't actually cover this period.
    if (history.length < days + 1) {
      result[key] = null;
      continue;
    }
    const start = history[history.length - 1 - days];
    result[key] = years != null ? annualizedPct(start, years) : cumulativePct(start);
  }

  // YTD: last entry of prior calendar year (Dec 31). Falls back to null
  // if the series doesn't extend into the prior year — same convention
  // as PimPerformance's filteredHistory YTD prepend. Reported as raw
  // cumulative (not annualized) since YTD is a partial-year window.
  const currentYear = new Date().getFullYear();
  const ytdCutoff = `${currentYear}-01-01`;
  let ytdBaseline: ValuePoint | null = null;
  for (const e of history) {
    if (e.date < ytdCutoff) ytdBaseline = e;
    else break;
  }
  result.ytd = cumulativePct(ytdBaseline);

  return result;
}

/* ─── Main Page ─── */
export default function AAPerformancePage() {
  const [data, setData] = useState<AAPerformanceData>(defaultData);
  const [loading, setLoading] = useState(true);
  const [pimData, setPimData] = useState<PimPerformanceData | null>(null);
  const [appendixData, setAppendixData] = useState<AppendixData | null>(null);
  // Start as loading so the "refreshing…" indicator shows on first paint
  // without needing to call setState inside the effect.
  const [pimLoading, setPimLoading] = useState(true);
  const [indexes, setIndexes] = useState<IndexHistoryEntry[]>([]);
  // Start as loading so the "refreshing…" indicator shows on first paint
  // without needing to call setState inside the effect (which lint flags
  // as a cascading-render anti-pattern).
  const [indexLoading, setIndexLoading] = useState(true);
  const persist = useDebouncedPersist(500);
  const { scoredStocks, pimModels, updatePimModels } = useStocks();

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

  /* Fetch PIM performance data on mount, mirroring the PIM Model page's
   * load sequence so the AA & Perf table sees the same dataset:
   *
   *   1. POST `/api/update-daily-value` to recompute today's value with
   *      the latest live prices and persist it. PimPerformance.tsx triggers
   *      this on every visit (autoUpdateDailyValue) — without it, AA & Perf
   *      can read a stale "today" entry written by an earlier session.
   *   2. GET `/api/kv/pim-performance` — the now-fresh Redis cache. This
   *      is the same source PimPerformance.tsx reads after seedFromAppendix
   *      validation, so non-Alpha rows match that screen exactly.
   *   3. GET `/api/kv/appendix-daily-values` in parallel as a fallback for
   *      any profile missing from pim-performance (typically Alpha).
   *
   * The client-side `liveTodayReturn` override is applied separately
   * (see `effectiveHistoryFor` below), matching PimPerformance.tsx's
   * effectiveHistory logic so today's value is corrected client-side when
   * the persisted value drifts. */
  useEffect(() => {
    let pimDone = false;
    let appendixDone = false;
    const checkDone = () => {
      if (pimDone && appendixDone) setPimLoading(false);
    };

    // Fire update-daily-value first; ignore errors (e.g. weekends or no
    // positions yet) and proceed to read the cache regardless.
    const reloadPim = () =>
      fetch("/api/kv/pim-performance")
        .then((r) => r.json())
        .then((res) => {
          if (res?.models) setPimData(res as PimPerformanceData);
        })
        .catch(() => {})
        .finally(() => {
          pimDone = true;
          checkDone();
        });

    fetch("/api/update-daily-value", { method: "POST" })
      .catch(() => {})
      .finally(() => {
        reloadPim();
      });

    fetch("/api/kv/appendix-daily-values")
      .then((r) => r.json())
      .then((res) => {
        if (res?.ledgers) setAppendixData(res as AppendixData);
      })
      .catch(() => {})
      .finally(() => {
        appendixDone = true;
        checkDone();
      });
  }, []);

  /* Live today's return for each PIM profile — uses the same shared hook
   * PimPerformance.tsx calls, so the client-side override applied below
   * matches that screen's effectiveHistory exactly. */
  const liveConservative = useLiveTodayReturn("pim", "conservative").value;
  const liveBalanced = useLiveTodayReturn("pim", "balanced").value;
  const liveGrowth = useLiveTodayReturn("pim", "growth").value;
  const liveAllEquity = useLiveTodayReturn("pim", "allEquity").value;
  const liveAlpha = useLiveTodayReturn("pim", "alpha").value;

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

  /* Displayed allocations — the "Current" row is sourced from the live
   * PIM Model profile weights (pm:pim-models) so the AA & Perf tab
   * becomes the authoritative editor. Target / Min / Max continue to
   * come from this page's own aa-performance store.
   *
   * Weights on the PIM model are stored as fractions (0–1); the UI
   * displays them as percentages. cadSplit / usdSplit live on the
   * group itself and are intentionally not touched here. */
  const fracToPct = (f: number) => Math.round(f * 10000) / 100;
  const displayedAllocations = useMemo(() => {
    const pimGroup = pimModels.groups.find((g) => g.id === "pim");
    const profiles: ("conservative" | "balanced" | "growth" | "allEquity")[] = ["conservative", "balanced", "growth", "allEquity"];
    const out: AAPerformanceData["allocations"] = { ...data.allocations };
    for (const p of profiles) {
      const w = pimGroup?.profiles[p];
      if (!w) continue;
      out[p] = {
        ...data.allocations[p],
        current: {
          fixedIncome: fracToPct(w.fixedIncome),
          equity: fracToPct(w.equity),
          alternatives: fracToPct(w.alternatives),
        },
      };
    }
    return out;
  }, [data.allocations, pimModels]);

  /* Allocation update.
   *
   * Current row → writes to pm:pim-models profile weights (source of
   * truth for the PIM Model screen, Positioning tab, performance
   * calcs, and Appendix). Cash is the implicit remainder: 1 − (fi + eq
   * + alt). cadSplit / usdSplit are unchanged.
   *
   * Target / Min / Max rows → persist to pm:aa-performance only (these
   * are policy bounds, not model weights). */
  const updateAllocation = useCallback(
    (
      tableKey: "conservative" | "balanced" | "growth" | "allEquity",
      rowKey: keyof AllocationTable,
      colKey: keyof AllocationRow,
      value: number
    ) => {
      if (rowKey === "current") {
        const pimGroup = pimModels.groups.find((g) => g.id === "pim");
        // Note: a profile MAY not exist yet in pm:pim-models (e.g. Conservative
        // before it's been seeded). We still allow the edit — the write below
        // creates the profile entry from the displayed values + this cell.
        if (!pimGroup) {
          console.warn("[AA→PIM] skipping write — no pim group");
          return;
        }

        // Start from whatever's currently shown (sourced from pim-models)
        // and override the edited cell. Other cells keep their live values.
        const shown = displayedAllocations[tableKey].current;
        const nextRowPct = { ...shown, [colKey]: value };

        const fi = Math.max(0, nextRowPct.fixedIncome) / 100;
        const eq = Math.max(0, nextRowPct.equity) / 100;
        const alt = Math.max(0, nextRowPct.alternatives) / 100;
        // Cash = remainder. If fi+eq+alt > 1 (user overshot), cash
        // clamps to 0 and the downstream math still balances.
        const cash = Math.max(0, 1 - fi - eq - alt);
        const nextWeights: PimProfileWeights = {
          cash,
          fixedIncome: fi,
          equity: eq,
          alternatives: alt,
        };

        console.log("[AA→PIM] write profile weights", {
          profile: tableKey,
          changed: colKey,
          to: value,
          prev: pimGroup.profiles[tableKey],
          next: nextWeights,
        });

        const nextGroups = pimModels.groups.map((g) =>
          g.id === "pim"
            ? { ...g, profiles: { ...g.profiles, [tableKey]: nextWeights } }
            : g
        );
        updatePimModels({
          ...pimModels,
          groups: nextGroups,
          lastUpdated: new Date().toISOString(),
        });
        return;
      }

      // target / min / max — policy bounds only, stays on aa-performance
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
    [updateData, pimModels, updatePimModels, displayedAllocations]
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
  //   • PIM Balanced / Growth / All-Equity / Alpha — for each profile, prefer
  //     the `pim-performance` cache (matches the PIM Model page exactly,
  //     including the historical tail loaded by `import-performance`). Fall
  //     back to the Appendix ledger when a profile is missing from the cache
  //     (typically Alpha on a fresh load before `update-daily-value` seeds).
  //
  //     We then apply the SAME effectiveHistory override PimPerformance.tsx
  //     uses: when liveTodayReturn is non-null and the persisted last entry
  //     is dated today, we replace today's value with
  //     `yesterdayValue × (1 + liveTodayReturn / 100)`. This corrects the
  //     persisted "today" entry when it drifts from the live market value
  //     (the same correction the PIM Model page displays).
  //
  //   • S&P 500 / S&P/TSX Composite — pulled from /api/index-history (Yahoo
  //     ^GSPC and ^GSPTSE).
  // Period returns for both are computed from the same value-history series
  // so the methodology is identical across rows.
  const autoPerformanceRows = useMemo<AutoPerfRow[]>(() => {
    const rows: AutoPerfRow[] = [];

    /** Mirrors PimPerformance.tsx's effectiveHistory: when there's a
     *  live today return AND the last entry is today's date, replace the
     *  last entry with yesterdayValue × (1 + liveTodayReturn / 100). */
    const applyLiveOverride = (
      hist: ValuePoint[],
      live: number | null
    ): ValuePoint[] => {
      if (live == null || hist.length < 2) return hist;
      const todayET = getTodayET();
      const last = hist[hist.length - 1];
      if (last.date !== todayET) return hist;
      const yesterdayValue = hist[hist.length - 2].value;
      const correctedValue = yesterdayValue * (1 + live / 100);
      return [...hist.slice(0, -1), { date: todayET, value: correctedValue }];
    };

    const pimProfiles: {
      profile: "conservative" | "balanced" | "growth" | "allEquity" | "alpha";
      label: string;
      live: number | null;
    }[] = [
      { profile: "conservative", label: "PIM Conservative", live: liveConservative },
      { profile: "balanced", label: "PIM Balanced", live: liveBalanced },
      { profile: "growth", label: "PIM Growth", live: liveGrowth },
      { profile: "allEquity", label: "PIM All-Equity", live: liveAllEquity },
      { profile: "alpha", label: "PIM Alpha", live: liveAlpha },
    ];
    for (const p of pimProfiles) {
      // Primary: pim-performance (matches PIM Model page)
      const model = pimData?.models.find(
        (m) => m.groupId === "pim" && m.profile === p.profile
      );
      let history: ValuePoint[] = model
        ? model.history.map((h) => ({ date: h.date, value: h.value }))
        : [];
      // Fallback: Appendix ledger (covers Alpha when not yet in pim-performance)
      if (history.length === 0) {
        const ledger = appendixData?.ledgers.find((l) => l.profile === p.profile);
        if (ledger) {
          history = ledger.entries.map((e) => ({ date: e.date, value: e.value }));
        }
      }
      // Apply the same client-side override PimPerformance.tsx uses
      history = applyLiveOverride(history, p.live);
      rows.push({ name: p.label, ...computePeriodReturns(history) });
    }

    for (const idx of indexes) {
      const history: ValuePoint[] = idx.history.map((b) => ({ date: b.date, value: b.close }));
      rows.push({ name: idx.label, ...computePeriodReturns(history) });
    }

    return rows;
  }, [pimData, appendixData, indexes, liveConservative, liveBalanced, liveGrowth, liveAllEquity, liveAlpha]);

  if (loading) {
    return (
      <main className="flex flex-col gap-3.5 text-ink">
        <section className="panel">
          <div className="panel-h"><span className="t">Performance</span></div>
          <div className="p-3.5"><SkeletonTable rows={8} cols={11} /></div>
        </section>
      </main>
    );
  }

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* ── Performance — the table comes first: it is what the page is for ── */}
      <section className="panel">
        <div className="panel-h flex-wrap py-1.5">
          <span className="t">Performance</span>
          <span className="m">Models, profiles and reference indices · 1Y and longer are annualized</span>
          {(pimLoading || indexLoading) && <span className="m ml-auto animate-pulse">refreshing…</span>}
        </div>
        <div className="max-w-full overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 min-w-[220px] bg-surface pl-3.5">Name</th>
                {PERIOD_COLS.map((col) => (
                  <th key={col.key} className="n">
                    {col.label}
                    {col.annualized && <span className="ml-1 text-ink-faint">ann.</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {autoPerformanceRows.map((row) => (
                <tr key={row.name} className="group">
                  <td className="sticky left-0 z-10 bg-surface pl-3.5 font-medium text-ink group-hover:bg-surface-hover">{row.name}</td>
                  {PERIOD_COLS.map((col) => {
                    const val = row[col.key];
                    return (
                      <td key={col.key} className={`n ${perfColor(val)}`}>
                        {formatPerf(val)}
                        {val !== null && <span className="ml-0.5 text-ink-3">%</span>}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Asset allocation — ONE panel, the four profile editors side by side ── */}
      <section className="panel">
        <div className="panel-h flex-wrap py-1.5">
          <span className="t">Asset allocation</span>
          <span className="m">
            The <span className="text-pos">Current</span> row edits the PIM Model profile weights.
            {pimModels.lastUpdated && (
              <>
                {" "}Last saved <span className="font-mono">{new Date(pimModels.lastUpdated).toLocaleTimeString()}</span>
              </>
            )}
          </span>
        </div>
        <div className="grid grid-cols-1 divide-y divide-line-soft sm:grid-cols-2 sm:divide-x xl:grid-cols-4 xl:divide-y-0">
          <AllocationEditor
            title="Conservative"
            table={displayedAllocations.conservative}
            onUpdate={(rowKey, colKey, value) => updateAllocation("conservative", rowKey, colKey, value)}
          />
          <AllocationEditor
            title="Balanced"
            table={displayedAllocations.balanced}
            onUpdate={(rowKey, colKey, value) => updateAllocation("balanced", rowKey, colKey, value)}
          />
          <AllocationEditor
            title="Growth"
            table={displayedAllocations.growth}
            onUpdate={(rowKey, colKey, value) => updateAllocation("growth", rowKey, colKey, value)}
          />
          <AllocationEditor
            title="All-Equity"
            table={displayedAllocations.allEquity}
            onUpdate={(rowKey, colKey, value) => updateAllocation("allEquity", rowKey, colKey, value)}
          />
        </div>
      </section>

      {/* ── Attribution — merged in from the old /attribution segment.
          The route still exists; this page is now the single Performance
          surface (allocation + performance + attribution). ── */}
      <div id="attribution" className="scroll-mt-24">
        <Attribution />
      </div>
    </main>
  );
}
