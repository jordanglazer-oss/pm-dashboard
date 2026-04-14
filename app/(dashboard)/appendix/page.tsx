"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { AppendixModelLedger, AppendixProfileType, PimTransaction, PimPortfolioState, PimProfileType, PimModelGroup } from "@/app/lib/pim-types";

type ViewMode = "daily" | "transactions";

const PROFILES: { key: AppendixProfileType; label: string }[] = [
  { key: "balanced", label: "Balanced" },
  { key: "growth", label: "Growth" },
  { key: "allEquity", label: "All-Equity" },
  { key: "alpha", label: "Alpha" },
];

const PROFILE_LABELS: Record<PimProfileType, string> = {
  balanced: "Balanced",
  growth: "Growth",
  allEquity: "All-Equity",
  alpha: "Alpha",
};

const PAGE_SIZE = 50;
const TX_PAGE_SIZE = 100;

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

function formatTxDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "2-digit" });
  } catch {
    return iso;
  }
}

function formatTxDateTime(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString("en-US", {
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
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

  // View mode: daily values vs transactions log
  const [viewMode, setViewMode] = useState<ViewMode>("daily");

  // Transaction log state
  const [portfolioState, setPortfolioState] = useState<PimPortfolioState | null>(null);
  const [groups, setGroups] = useState<PimModelGroup[]>([]);
  const [txLoading, setTxLoading] = useState(false);
  const [txPage, setTxPage] = useState(0);
  const [txSearch, setTxSearch] = useState("");
  const [txProfileFilter, setTxProfileFilter] = useState<PimProfileType | "all">("all");
  const [txTypeFilter, setTxTypeFilter] = useState<"all" | "rebalance" | "buy" | "sell" | "switch">("all");
  const [txStatusFilter, setTxStatusFilter] = useState<"all" | "settled" | "pending">("all");
  const [txGroupFilter, setTxGroupFilter] = useState<string>("all");

  const fetchData = useCallback(async () => {
    setTxLoading(true);
    try {
      const [ledgerRes, stateRes, modelsRes] = await Promise.all([
        fetch("/api/kv/appendix-daily-values"),
        fetch("/api/kv/pim-portfolio-state"),
        fetch("/api/kv/pim-models"),
      ]);
      if (ledgerRes.ok) {
        const data = await ledgerRes.json();
        setLedgers(data.ledgers || []);
      }
      if (stateRes.ok) {
        const data = await stateRes.json();
        setPortfolioState(data);
      }
      if (modelsRes.ok) {
        const data = await modelsRes.json();
        setGroups(data.groups || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
    setTxLoading(false);
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

  // ── Transactions ──────────────────────────────────────────────
  const allTransactions = useMemo(() => {
    if (!portfolioState) return [] as PimTransaction[];
    const txs: PimTransaction[] = [];
    for (const g of portfolioState.groupStates || []) {
      for (const t of g.transactions || []) {
        txs.push(t);
      }
    }
    // Sort newest first
    txs.sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0));
    return txs;
  }, [portfolioState]);

  const groupNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of groups) m.set(g.id, g.name);
    return m;
  }, [groups]);

  const filteredTransactions = useMemo(() => {
    let list = allTransactions;
    if (txProfileFilter !== "all") list = list.filter((t) => t.profile === txProfileFilter);
    if (txTypeFilter !== "all") list = list.filter((t) => t.type === txTypeFilter);
    if (txStatusFilter !== "all") list = list.filter((t) => (t.status || "settled") === txStatusFilter);
    if (txGroupFilter !== "all") list = list.filter((t) => t.groupId === txGroupFilter);
    if (txSearch.trim()) {
      const q = txSearch.trim().toLowerCase();
      list = list.filter((t) =>
        t.symbol.toLowerCase().includes(q) ||
        t.date.toLowerCase().includes(q) ||
        (t.notes || "").toLowerCase().includes(q)
      );
    }
    return list;
  }, [allTransactions, txProfileFilter, txTypeFilter, txStatusFilter, txGroupFilter, txSearch]);

  const txTotalPages = Math.ceil(filteredTransactions.length / TX_PAGE_SIZE);
  const pageTransactions = filteredTransactions.slice(txPage * TX_PAGE_SIZE, (txPage + 1) * TX_PAGE_SIZE);

  const txStats = useMemo(() => {
    const total = allTransactions.length;
    const pending = allTransactions.filter((t) => t.status === "pending").length;
    const settled = total - pending;
    const rebalances = allTransactions.filter((t) => t.type === "rebalance").length;
    return { total, pending, settled, rebalances };
  }, [allTransactions]);

  const exportTransactionsCSV = useCallback(() => {
    const rows = [
      ["Date", "Profile", "Group", "Type", "Symbol", "Direction", "Price", "Target Weight", "Target Amount (CAD)", "Status", "Settled At", "Notes"],
    ];
    for (const t of filteredTransactions) {
      rows.push([
        t.date,
        t.profile || "",
        groupNameById.get(t.groupId) || t.groupId,
        t.type,
        t.symbol,
        t.direction,
        String(t.price ?? ""),
        String(t.targetWeight ?? ""),
        String(t.targetAmount ?? ""),
        t.status || "settled",
        t.settledAt || "",
        (t.notes || "").replace(/"/g, '""'),
      ]);
    }
    const csv = rows
      .map((r) => r.map((c) => (/[,"\n]/.test(c) ? `"${c}"` : c)).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `pim-transactions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filteredTransactions, groupNameById]);

  // Handle JSON file import
  const handleFileImport = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImporting(true);
    setImportStatus(null);

    try {
      const text = await file.text();
      const data = JSON.parse(text);

      if (Array.isArray(data)) {
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
              {viewMode === "daily"
                ? "Permanent daily value ledger — immutable historical record for each model"
                : "Permanent transaction log — every rebalance, buy, sell, and switch"}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {viewMode === "daily" && (
              <>
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
              </>
            )}
            {viewMode === "transactions" && allTransactions.length > 0 && (
              <button
                onClick={exportTransactionsCSV}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 transition-colors"
              >
                Export CSV
              </button>
            )}
          </div>
        </div>

        {/* View Toggle */}
        <div className="flex gap-1 mb-5 bg-white rounded-xl border border-slate-200 p-1 w-fit">
          <button
            onClick={() => setViewMode("daily")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
              viewMode === "daily" ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"
            }`}
          >
            Daily Values
          </button>
          <button
            onClick={() => setViewMode("transactions")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
              viewMode === "transactions" ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"
            }`}
          >
            Transactions
            {portfolioState && allTransactions.length > 0 && (
              <span className={`ml-1.5 text-[10px] font-bold ${viewMode === "transactions" ? "text-slate-300" : "text-slate-400"}`}>
                ({allTransactions.length.toLocaleString()})
              </span>
            )}
          </button>
        </div>

        {importStatus && viewMode === "daily" && (
          <div className={`mb-4 rounded-xl px-4 py-3 text-sm font-medium ${
            importStatus.startsWith("Error") ? "bg-red-50 text-red-700" : "bg-emerald-50 text-emerald-700"
          }`}>
            {importStatus}
            <button onClick={() => setImportStatus(null)} className="ml-3 text-xs opacity-60 hover:opacity-100">dismiss</button>
          </div>
        )}

        {viewMode === "daily" ? (
          <>
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
          </>
        ) : (
          // ── Transactions View ─────────────────────────────────
          <>
            {txLoading ? (
              <div className="text-center py-12 text-slate-400 text-sm">Loading transactions...</div>
            ) : allTransactions.length === 0 ? (
              <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-8 text-center">
                <p className="text-slate-400 text-sm mb-1">No transactions recorded yet</p>
                <p className="text-xs text-slate-400">Transactions appear here after you rebalance or trade in the PIM portfolio.</p>
              </div>
            ) : (
              <>
                {/* Summary Stats */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-5">
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Total Transactions</div>
                    <div className="text-sm font-bold mt-0.5 text-slate-800">{txStats.total.toLocaleString()}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Rebalances</div>
                    <div className="text-sm font-bold mt-0.5 text-slate-800">{txStats.rebalances.toLocaleString()}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Settled</div>
                    <div className="text-sm font-bold mt-0.5 text-emerald-600">{txStats.settled.toLocaleString()}</div>
                  </div>
                  <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm">
                    <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider">Pending</div>
                    <div className="text-sm font-bold mt-0.5 text-violet-600">{txStats.pending.toLocaleString()}</div>
                  </div>
                </div>

                {/* Filters */}
                <div className="flex flex-wrap items-center gap-2 mb-3">
                  <input
                    type="text"
                    value={txSearch}
                    onChange={(e) => { setTxSearch(e.target.value); setTxPage(0); }}
                    placeholder="Search symbol, date, notes..."
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm w-full sm:w-64 outline-none focus:border-blue-300 focus:ring-2 focus:ring-blue-100"
                  />
                  <select
                    value={txProfileFilter}
                    onChange={(e) => { setTxProfileFilter(e.target.value as PimProfileType | "all"); setTxPage(0); }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
                  >
                    <option value="all">All Profiles</option>
                    {PROFILES.map((p) => (
                      <option key={p.key} value={p.key}>{p.label}</option>
                    ))}
                  </select>
                  <select
                    value={txTypeFilter}
                    onChange={(e) => { setTxTypeFilter(e.target.value as typeof txTypeFilter); setTxPage(0); }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
                  >
                    <option value="all">All Types</option>
                    <option value="rebalance">Rebalance</option>
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                    <option value="switch">Switch</option>
                  </select>
                  <select
                    value={txStatusFilter}
                    onChange={(e) => { setTxStatusFilter(e.target.value as typeof txStatusFilter); setTxPage(0); }}
                    className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
                  >
                    <option value="all">All Status</option>
                    <option value="settled">Settled</option>
                    <option value="pending">Pending</option>
                  </select>
                  {groups.length > 1 && (
                    <select
                      value={txGroupFilter}
                      onChange={(e) => { setTxGroupFilter(e.target.value); setTxPage(0); }}
                      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-300"
                    >
                      <option value="all">All Models</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  )}
                  {txTotalPages > 1 && (
                    <div className="flex items-center gap-2 text-xs text-slate-500 ml-auto">
                      <button
                        onClick={() => setTxPage(Math.max(0, txPage - 1))}
                        disabled={txPage === 0}
                        className="rounded px-2 py-1 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-30"
                      >
                        Prev
                      </button>
                      <span>Page {txPage + 1} of {txTotalPages}</span>
                      <button
                        onClick={() => setTxPage(Math.min(txTotalPages - 1, txPage + 1))}
                        disabled={txPage >= txTotalPages - 1}
                        className="rounded px-2 py-1 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-30"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </div>

                {/* Transactions Table */}
                <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-slate-100 bg-slate-50 text-xs text-slate-500">
                          <th className="text-left py-2.5 pl-5 pr-2 font-semibold">Date</th>
                          <th className="text-left py-2.5 px-2 font-semibold hidden md:table-cell">Model</th>
                          <th className="text-left py-2.5 px-2 font-semibold hidden sm:table-cell">Profile</th>
                          <th className="text-left py-2.5 px-2 font-semibold">Type</th>
                          <th className="text-left py-2.5 px-2 font-semibold">Symbol</th>
                          <th className="text-center py-2.5 px-2 font-semibold">Dir</th>
                          <th className="text-right py-2.5 px-2 font-semibold">Price</th>
                          <th className="text-right py-2.5 px-2 font-semibold hidden md:table-cell">Target %</th>
                          <th className="text-right py-2.5 px-2 font-semibold hidden lg:table-cell">Amount (CAD)</th>
                          <th className="text-center py-2.5 pr-5 pl-2 font-semibold">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageTransactions.map((t) => {
                          const status = t.status || "settled";
                          const groupName = groupNameById.get(t.groupId) || t.groupId;
                          return (
                            <tr key={t.id} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                              <td className="py-2 pl-5 pr-2 text-xs text-slate-700 whitespace-nowrap">
                                <div className="font-medium">{formatTxDate(t.date)}</div>
                                <div className="text-[10px] text-slate-400 hidden sm:block">{new Date(t.date).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</div>
                              </td>
                              <td className="py-2 px-2 text-xs text-slate-600 hidden md:table-cell">{groupName}</td>
                              <td className="py-2 px-2 text-xs text-slate-600 hidden sm:table-cell">
                                {t.profile ? PROFILE_LABELS[t.profile] : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="py-2 px-2">
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                  t.type === "rebalance" ? "bg-blue-100 text-blue-700" :
                                  t.type === "buy" ? "bg-emerald-100 text-emerald-700" :
                                  t.type === "sell" ? "bg-red-100 text-red-700" :
                                  "bg-amber-100 text-amber-700"
                                }`}>
                                  {t.type}
                                </span>
                              </td>
                              <td className="py-2 px-2 font-mono text-xs font-semibold text-slate-800">{t.symbol}</td>
                              <td className="py-2 px-2 text-center">
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${
                                  t.direction === "buy" ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"
                                }`}>
                                  {t.direction.toUpperCase()}
                                </span>
                              </td>
                              <td className="py-2 px-2 text-right font-mono text-xs">
                                {t.price > 0 ? t.price.toFixed(4) : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="py-2 px-2 text-right font-mono text-xs text-slate-600 hidden md:table-cell">
                                {(t.targetWeight * 100).toFixed(2)}%
                              </td>
                              <td className="py-2 px-2 text-right font-mono text-xs text-slate-600 hidden lg:table-cell">
                                {t.targetAmount ? `$${t.targetAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : <span className="text-slate-300">—</span>}
                              </td>
                              <td className="py-2 pr-5 pl-2 text-center">
                                <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase ${
                                  status === "settled" ? "bg-slate-100 text-slate-600" : "bg-violet-100 text-violet-700"
                                }`} title={status === "settled" && t.settledAt ? `Settled ${formatTxDateTime(t.settledAt)}` : ""}>
                                  {status}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="px-5 py-3 border-t border-slate-100 text-xs text-slate-400 text-center">
                    {filteredTransactions.length === 0 ? (
                      "No transactions match your filters"
                    ) : (
                      <>Showing {txPage * TX_PAGE_SIZE + 1}–{Math.min((txPage + 1) * TX_PAGE_SIZE, filteredTransactions.length)} of {filteredTransactions.length.toLocaleString()} transactions (most recent first)</>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
