"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { AppendixModelLedger, AppendixDailyValue, AppendixProfileType } from "@/app/lib/pim-types";

const PROFILES: { key: AppendixProfileType; label: string }[] = [
  { key: "balanced", label: "Balanced" },
  { key: "growth", label: "Growth" },
  { key: "allEquity", label: "All-Equity" },
  { key: "alpha", label: "Alpha" },
];

const PAGE_SIZE = 50;

function formatDate(d: string) {
  const [y, m, day] = d.split("-");
  return `${m}/${day}/${y}`;
}

function formatPct(v: number) {
  if (v === 0) return "0.00%";
  return (v >= 0 ? "+" : "") + v.toFixed(4) + "%";
}

function formatValue(v: number) {
  return v.toFixed(4);
}

export default function AppendixPage() {
  const [ledgers, setLedgers] = useState<AppendixModelLedger[]>([]);
  const [activeTab, setActiveTab] = useState<AppendixProfileType>("allEquity");
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/kv/appendix-daily-values");
      if (res.ok) {
        const data = await res.json();
        setLedgers(data.ledgers || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Reset page when switching tabs
  useEffect(() => { setPage(0); setSearch(""); }, [activeTab]);

  const activeLedger = ledgers.find((l) => l.profile === activeTab);
  const allEntries = activeLedger?.entries || [];

  // Filter by search (date)
  const filteredEntries = useMemo(() => {
    if (!search.trim()) return allEntries;
    const q = search.trim().toLowerCase();
    return allEntries.filter((e) => e.date.includes(q) || formatDate(e.date).toLowerCase().includes(q));
  }, [allEntries, search]);

  // Most recent first for display
  const sortedEntries = useMemo(() => [...filteredEntries].reverse(), [filteredEntries]);
  const totalPages = Math.ceil(sortedEntries.length / PAGE_SIZE);
  const pageEntries = sortedEntries.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Stats
  const stats = useMemo(() => {
    if (allEntries.length === 0) return null;
    const first = allEntries[0];
    const last = allEntries[allEntries.length - 1];
    const totalReturn = ((last.value - first.value) / first.value) * 100;
    const years = (new Date(last.date).getTime() - new Date(first.date).getTime()) / (365.25 * 24 * 60 * 60 * 1000);
    const cagr = years > 0 ? (Math.pow(last.value / first.value, 1 / years) - 1) * 100 : 0;
    const bestDay = allEntries.reduce((best, e) => e.dailyReturn > best.dailyReturn ? e : best, allEntries[0]);
    const worstDay = allEntries.reduce((worst, e) => e.dailyReturn < worst.dailyReturn ? e : worst, allEntries[0]);
    return {
      firstDate: first.date,
      lastDate: last.date,
      startValue: first.value,
      endValue: last.value,
      totalReturn,
      cagr,
      totalDays: allEntries.length,
      bestDay,
      worstDay,
    };
  }, [allEntries]);

  // Handle JSON file import
  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportStatus(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Support multiple formats:
      // 1. Array of { date, value, dailyReturn }
      // 2. Object with { profile, entries }
      // 3. Object with { balanced: [...], growth: [...], allEquity: [...], alpha: [...] }
      if (Array.isArray(data)) {
        // Single profile — import into active tab
        const res = await fetch("/api/kv/appendix-daily-values", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: activeTab, entries: data, seed: true }),
        });
        const result = await res.json();
        setImportStatus(result.ok ? `Imported ${result.added} entries into ${activeTab}` : result.message || "Import failed");
      } else if (data.profile && data.entries) {
        const res = await fetch("/api/kv/appendix-daily-values", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ profile: data.profile, entries: data.entries, seed: true }),
        });
        const result = await res.json();
        setImportStatus(result.ok ? `Imported ${result.added} entries into ${data.profile}` : result.message || "Import failed");
      } else {
        // Multi-profile object
        const results: string[] = [];
        for (const key of Object.keys(data)) {
          if (["balanced", "growth", "allEquity", "alpha"].includes(key) && Array.isArray(data[key])) {
            const res = await fetch("/api/kv/appendix-daily-values", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ profile: key, entries: data[key], seed: true }),
            });
            const result = await res.json();
            results.push(`${key}: ${result.ok ? `${result.added} added` : result.message}`);
          }
        }
        setImportStatus(results.join(" | "));
      }
      await fetchData();
    } catch (err) {
      setImportStatus(`Error: ${err instanceof Error ? err.message : "Failed to parse file"}`);
    }

    setImporting(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [activeTab, fetchData]);

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Appendix</h1>
            <p className="text-sm text-slate-500 mt-1">
              Permanent daily value ledger — immutable historical record for each model
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json"
              onChange={handleFileImport}
              className="hidden"
              id="appendix-import"
            />
            <label
              htmlFor="appendix-import"
              className={`cursor-pointer rounded-lg px-4 py-2 text-sm font-semibold transition-colors ${
                importing
                  ? "bg-slate-200 text-slate-400 cursor-not-allowed"
                  : "bg-blue-600 text-white hover:bg-blue-700"
              }`}
            >
              {importing ? "Importing..." : "Import JSON"}
            </label>
          </div>
        </div>

        {importStatus && (
          <div className={`mb-4 rounded-xl px-4 py-3 text-sm font-medium ${
            importStatus.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
          }`}>
            {importStatus}
            <button onClick={() => setImportStatus(null)} className="ml-3 text-xs opacity-60 hover:opacity-100">dismiss</button>
          </div>
        )}

        {/* Profile Tabs */}
        <div className="flex gap-1 mb-5 bg-white rounded-xl border border-slate-200 p-1 w-fit">
          {PROFILES.map((p) => {
            const ledger = ledgers.find((l) => l.profile === p.key);
            const count = ledger?.entries.length || 0;
            return (
              <button
                key={p.key}
                onClick={() => setActiveTab(p.key)}
                className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
                  activeTab === p.key
                    ? "bg-blue-600 text-white"
                    : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"
                }`}
              >
                {p.label}
                {count > 0 && (
                  <span className={`ml-1.5 text-[10px] font-bold ${activeTab === p.key ? "text-blue-200" : "text-slate-400"}`}>
                    ({count.toLocaleString()})
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="text-center py-12 text-slate-400 text-sm">Loading...</div>
        ) : !activeLedger || allEntries.length === 0 ? (
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-8 text-center">
            <p className="text-slate-400 text-sm mb-3">No daily values recorded for {PROFILES.find((p) => p.key === activeTab)?.label}</p>
            <p className="text-xs text-slate-400">
              Import a JSON file with an array of <code className="bg-slate-100 px-1 rounded">{"{ date, value, dailyReturn }"}</code> entries
            </p>
          </div>
        ) : (
          <>
            {/* Summary Stats */}
            {stats && (
              <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 mb-5">
                {[
                  { label: "Start Date", value: formatDate(stats.firstDate) },
                  { label: "End Date", value: formatDate(stats.lastDate) },
                  { label: "Trading Days", value: stats.totalDays.toLocaleString() },
                  { label: "Start Value", value: formatValue(stats.startValue) },
                  { label: "End Value", value: formatValue(stats.endValue) },
                  { label: "Total Return", value: `${stats.totalReturn >= 0 ? "+" : ""}${stats.totalReturn.toFixed(2)}%`, color: stats.totalReturn >= 0 ? "text-emerald-600" : "text-red-600" },
                  { label: "CAGR", value: `${stats.cagr >= 0 ? "+" : ""}${stats.cagr.toFixed(2)}%`, color: stats.cagr >= 0 ? "text-emerald-600" : "text-red-600" },
                ].map((s) => (
                  <div key={s.label} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">{s.label}</div>
                    <div className={`text-sm font-bold mt-0.5 ${"color" in s ? s.color : "text-slate-800"}`}>{s.value}</div>
                  </div>
                ))}
              </div>
            )}

            {/* Best / Worst Day */}
            {stats && (
              <div className="flex gap-3 mb-5">
                <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-2 text-xs">
                  <span className="font-semibold text-emerald-700">Best Day:</span>{" "}
                  <span className="text-emerald-600">{formatDate(stats.bestDay.date)} {formatPct(stats.bestDay.dailyReturn)}</span>
                </div>
                <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-2 text-xs">
                  <span className="font-semibold text-red-700">Worst Day:</span>{" "}
                  <span className="text-red-600">{formatDate(stats.worstDay.date)} {formatPct(stats.worstDay.dailyReturn)}</span>
                </div>
              </div>
            )}

            {/* Search + Pagination */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 mb-3">
              <input
                type="text"
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                placeholder="Search by date (YYYY-MM-DD)..."
                className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm w-full sm:w-64 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
              />
              {totalPages > 1 && (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <button
                    onClick={() => setPage(Math.max(0, page - 1))}
                    disabled={page === 0}
                    className="rounded px-2 py-1 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-30"
                  >
                    Prev
                  </button>
                  <span>Page {page + 1} of {totalPages}</span>
                  <button
                    onClick={() => setPage(Math.min(totalPages - 1, page + 1))}
                    disabled={page >= totalPages - 1}
                    className="rounded px-2 py-1 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-30"
                  >
                    Next
                  </button>
                </div>
              )}
            </div>

            {/* Data Table */}
            <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
                      <th className="text-left py-2.5 pl-5 pr-2 font-semibold">#</th>
                      <th className="text-left py-2.5 px-2 font-semibold">Date</th>
                      <th className="text-right py-2.5 px-2 font-semibold">Index Value</th>
                      <th className="text-right py-2.5 px-2 font-semibold">Daily Return</th>
                      <th className="text-center py-2.5 px-2 font-semibold">Source</th>
                      <th className="text-right py-2.5 pr-5 pl-2 font-semibold text-slate-400">Recorded</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pageEntries.map((entry, i) => {
                      const globalIdx = allEntries.length - (page * PAGE_SIZE + i);
                      return (
                        <tr key={entry.date} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                          <td className="py-1.5 pl-5 pr-2 text-xs text-slate-400 font-mono">{globalIdx}</td>
                          <td className="py-1.5 px-2 font-mono text-xs font-medium text-slate-700">{entry.date}</td>
                          <td className="py-1.5 px-2 text-right font-mono text-xs font-semibold">{formatValue(entry.value)}</td>
                          <td className={`py-1.5 px-2 text-right font-mono text-xs font-semibold ${
                            entry.dailyReturn > 0 ? "text-emerald-600" : entry.dailyReturn < 0 ? "text-red-500" : "text-slate-400"
                          }`}>
                            {formatPct(entry.dailyReturn)}
                          </td>
                          <td className="py-1.5 px-2 text-center">
                            <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                              entry.date < "2026-04-07"
                                ? "bg-purple-100 text-purple-700"
                                : "bg-blue-100 text-blue-700"
                            }`}>
                              {entry.date < "2026-04-07" ? "SIA" : "PIM"}
                            </span>
                          </td>
                          <td className="py-1.5 pr-5 pl-2 text-right text-[10px] text-slate-300">
                            {entry.addedAt ? new Date(entry.addedAt).toLocaleDateString() : "seed"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-400 text-center">
                  Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sortedEntries.length)} of {sortedEntries.length.toLocaleString()} entries (most recent first)
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </main>
  );
}
