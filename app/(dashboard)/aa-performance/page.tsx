"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { ImageUpload, type BriefAttachment } from "@/app/components/ImageUpload";

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

type PerformanceRow = {
  name: string;
  ytd: number | null;
  "1d": number | null;
  "1w": number | null;
  "1m": number | null;
  "3m": number | null;
  "6m": number | null;
  "1y": number | null;
  "2y": number | null;
  "3y": number | null;
  "5y": number | null;
};

type AAPerformanceData = {
  allocations: {
    balanced: AllocationTable;
    growth: AllocationTable;
    allEquity: AllocationTable;
  };
  performance: PerformanceRow[];
  attachments: BriefAttachment[];
};

const PERF_COLS: { key: keyof PerformanceRow; label: string }[] = [
  { key: "name", label: "Name" },
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
  performance: [
    { name: "DWM - Balanced Model", ytd: -2.89, "1d": -0.92, "1w": -1.83, "1m": -1.70, "3m": -3.56, "6m": -2.29, "1y": 9.42, "2y": 9.09, "3y": 12.00, "5y": 3.92 },
    { name: "DWM - Balanced Small", ytd: -2.23, "1d": -1.07, "1w": -1.54, "1m": -1.43, "3m": -2.57, "6m": -0.15, "1y": 13.44, "2y": 10.40, "3y": 13.70, "5y": 3.38 },
    { name: "DWM - Growth Model", ytd: -3.40, "1d": -1.06, "1w": -1.99, "1m": -1.92, "3m": -4.15, "6m": -2.68, "1y": 11.91, "2y": 10.43, "3y": 14.13, "5y": 4.29 },
    { name: "DWM - Growth Small", ytd: -2.74, "1d": -1.25, "1w": -1.71, "1m": -1.49, "3m": -2.79, "6m": 0.15, "1y": 16.94, "2y": 12.27, "3y": 16.29, "5y": 3.66 },
    { name: "DWM - All-Equity Model", ytd: -3.92, "1d": -1.20, "1w": -2.15, "1m": -2.14, "3m": -4.74, "6m": -3.06, "1y": 14.28, "2y": 11.51, "3y": 16.58, "5y": 4.69 },
    { name: "DWM - All-Equity Small", ytd: -3.24, "1d": -1.43, "1w": -1.89, "1m": -1.56, "3m": -3.01, "6m": 0.44, "1y": 20.19, "2y": 13.93, "3y": 19.28, "5y": 3.92 },
    { name: "DWM - Alpha Model", ytd: -5.02, "1d": -1.23, "1w": -2.34, "1m": -1.68, "3m": -6.48, "6m": -6.21, "1y": 13.22, "2y": null, "3y": null, "5y": null },
    { name: "S&P 500 INDEX", ytd: -3.13, "1d": -1.20, "1w": -2.58, "1m": -2.16, "3m": -3.21, "6m": -0.15, "1y": 13.11, "2y": 14.16, "3y": 19.46, "5y": 13.08 },
    { name: "S&P/TSX COMPOSITE INDEX", ytd: 3.56, "1d": -0.84, "1w": -2.29, "1m": 1.16, "3m": 4.17, "6m": 12.15, "1y": 34.46, "2y": 22.65, "3y": 18.42, "5y": 11.74 },
  ],
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
                          } focus:outline-none focus:ring-2 focus:ring-blue-300`}
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

/* ─── Format helper for performance values ─── */
function formatPerf(v: number | null): string {
  if (v === null) return "—";
  return v.toFixed(2);
}

function perfColor(v: number | null): string {
  if (v === null) return "text-slate-400";
  return v < 0 ? "text-red-600" : v > 0 ? "text-emerald-600" : "text-slate-600";
}

/* ─── Main Page ─── */
export default function AAPerformancePage() {
  const [data, setData] = useState<AAPerformanceData>(defaultData);
  const [loading, setLoading] = useState(true);
  const persist = useDebouncedPersist(500);

  /* Load from KV on mount */
  useEffect(() => {
    fetch("/api/kv/aa-performance")
      .then((r) => r.json())
      .then((res) => {
        if (res.aaPerformance) {
          // Merge with defaults so new fields are always present
          setData({
            ...defaultData,
            ...res.aaPerformance,
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

  /* Performance update */
  const updatePerformance = useCallback(
    (rowIdx: number, key: string, value: number | null | string) => {
      updateData((prev) => ({
        ...prev,
        performance: prev.performance.map((row, i) =>
          i === rowIdx ? { ...row, [key]: value } : row
        ),
      }));
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
        <h2 className="text-xl font-bold text-slate-800 mb-4">Performance</h2>
        <div className="rounded-[30px] border border-slate-200 bg-white shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  {PERF_COLS.map((col) => (
                    <th
                      key={col.key}
                      className={`px-3 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wider ${
                        col.key === "name" ? "text-left min-w-[220px]" : "text-center"
                      }`}
                    >
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.performance.map((row, rowIdx) => (
                  <tr key={rowIdx} className="border-b border-slate-50 hover:bg-slate-50/50">
                    {/* Name column */}
                    <td className="px-3 py-1.5">
                      <input
                        type="text"
                        value={row.name}
                        onChange={(e) => updatePerformance(rowIdx, "name", e.target.value)}
                        className="w-full rounded-lg border border-transparent px-2 py-1 text-sm font-medium text-slate-800 hover:border-slate-200 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-transparent"
                      />
                    </td>
                    {/* Numeric columns */}
                    {PERF_COLS.filter((c) => c.key !== "name").map((col) => {
                      const val = row[col.key] as number | null;
                      return (
                        <td key={col.key} className="px-1 py-1.5 text-center">
                          <div className="flex items-center justify-center gap-0.5">
                            <NumericInput
                              value={val}
                              onChange={(n) => updatePerformance(rowIdx, col.key, n)}
                              placeholder="—"
                              className={`w-16 rounded-lg border border-transparent px-1 py-1 text-sm text-center font-medium ${perfColor(val)} hover:border-slate-200 focus:border-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-200 bg-transparent`}
                            />
                            {val !== null && <span className="text-[10px] text-slate-400">%</span>}
                          </div>
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
    </div>
  );
}
