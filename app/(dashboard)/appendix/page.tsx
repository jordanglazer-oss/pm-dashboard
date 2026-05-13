"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { AppendixModelLedger, AppendixProfileType, PimTransaction, PimPortfolioState, PimProfileType, PimModelGroup } from "@/app/lib/pim-types";

type ViewMode = "daily" | "transactions" | "sia-import";

type ParsedRow = { date: string; value: number };
type SiaDryRunSummary = {
  profile: string;
  fromDate: string;
  baselineValue: number;
  importedValueCount: number;
  firstImportedDate: string;
  lastImportedDate: string;
  newYtdPct: number;
  existingYtdPct: number | null;
  anchoredLastEntry: boolean;
  entriesBeingReplaced: { perf: number; appendix: number };
  preFromDateEntriesPreserved: { perf: number; appendix: number };
  anchorPreValue: { date: string; value: number } | null;
};
type SiaImportResponse = {
  ok: boolean;
  dryRun: boolean;
  wrote: boolean;
  summary: SiaDryRunSummary;
  stashKeys?: { perf: string | null; appendix: string | null };
  error?: string;
};

/** Parse SIA Charts CSV: ,Edit,Date,Trades,"Corp. Act.",Cash,Total
 *  Date in MM/DD/YYYY (col 3), Total quoted with $ and commas (col 7).
 *  Returns ascending-by-date values. */
function parseSiaCsvText(text: string): { rows: ParsedRow[]; warnings: string[] } {
  function parseRow(line: string): string[] {
    const out: string[] = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQuote = !inQuote;
      else if (c === "," && !inQuote) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }
  const warnings: string[] = [];
  const lines = text.trim().split(/\r?\n/);
  const rows: ParsedRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseRow(lines[i]);
    if (cols.length < 7) continue;
    const dateRaw = cols[2].trim();
    const totalRaw = cols[6].trim().replace(/\$/g, "").replace(/,/g, "");
    const total = parseFloat(totalRaw);
    if (!isFinite(total) || total <= 0) continue;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(dateRaw);
    if (!m) continue;
    rows.push({ date: `${m[3]}-${m[1]}-${m[2]}`, value: total });
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length === 0) {
    warnings.push("No rows parsed — verify the CSV is in SIA Charts format (Date in column 3, Total in column 7).");
  }
  return { rows, warnings };
}

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
  core: "Core",
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

  // View mode: daily values vs transactions log vs SIA import
  const [viewMode, setViewMode] = useState<ViewMode>("daily");

  // SIA Import state (third view tab) — wraps /api/admin/import-third-
  // party-values in a click-through UI for recurring CSV imports.
  const [siaProfile, setSiaProfile] = useState<PimProfileType>("alpha");
  const [siaFileName, setSiaFileName] = useState<string | null>(null);
  const [siaParsed, setSiaParsed] = useState<ParsedRow[] | null>(null);
  const [siaParseWarnings, setSiaParseWarnings] = useState<string[]>([]);
  const [siaDryRun, setSiaDryRun] = useState<SiaImportResponse | null>(null);
  const [siaWriteResult, setSiaWriteResult] = useState<SiaImportResponse | null>(null);
  const [siaLoading, setSiaLoading] = useState(false);
  const [siaError, setSiaError] = useState<string | null>(null);
  const siaFileInputRef = useRef<HTMLInputElement>(null);

  // Rollback state — list of available stashes (pm:*.pre-import-<ts>)
  // and the result of any rollback action.
  type StashRow = {
    timestamp: number;
    date: string;
    perfKey: string | null;
    appendixKey: string | null;
    perfSizeBytes: number | null;
    appendixSizeBytes: number | null;
    complete: boolean;
  };
  const [stashes, setStashes] = useState<StashRow[]>([]);
  const [stashesLoading, setStashesLoading] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<{ ok: boolean; wrote?: boolean; restoredFrom?: { timestamp: number; date: string }; preRollbackStashKeys?: { perf: string | null; appendix: string | null }; error?: string } | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);

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

  // ── SIA Import handlers ──────────────────────────────────────────
  // Pick a profile, upload a SIA Charts CSV, parse client-side, call
  // /api/admin/import-third-party-values with dryRun:true to preview,
  // then click Apply (with confirm dialog) to write. The endpoint
  // marks all imported entries anchored:true so they're locked from
  // future daily-update overwrites.
  const handleSiaFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setSiaFileName(file.name);
    setSiaDryRun(null);
    setSiaWriteResult(null);
    setSiaError(null);
    try {
      const text = await file.text();
      const { rows, warnings } = parseSiaCsvText(text);
      setSiaParsed(rows);
      setSiaParseWarnings(warnings);
    } catch (err) {
      setSiaError(err instanceof Error ? err.message : String(err));
      setSiaParsed(null);
    }
  }, []);

  const callSiaImport = useCallback(async (dryRunFlag: boolean): Promise<SiaImportResponse | null> => {
    if (!siaParsed) return null;
    setSiaLoading(true);
    setSiaError(null);
    try {
      const priorYearStart = `${parseInt(new Date().toISOString().slice(0, 4)) - 1}-01-01`;
      const values = siaParsed.filter((v) => v.date >= priorYearStart);
      const res = await fetch("/api/admin/import-third-party-values", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ profile: siaProfile, values, dryRun: dryRunFlag }),
      });
      const data = await res.json() as SiaImportResponse;
      if (!res.ok || data.error) {
        setSiaError(data.error || `HTTP ${res.status}`);
        return null;
      }
      return data;
    } catch (err) {
      setSiaError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setSiaLoading(false);
    }
  }, [siaParsed, siaProfile]);

  const handleSiaDryRun = useCallback(async () => {
    const data = await callSiaImport(true);
    if (data) {
      setSiaDryRun(data);
      setSiaWriteResult(null);
    }
  }, [callSiaImport]);

  const handleSiaApply = useCallback(async () => {
    if (!siaDryRun) return;
    const ok = confirm(
      `Confirm WRITE for ${siaProfile.toUpperCase()}?\n\n` +
      `Replaces current-year daily values in pm:pim-performance and pm:appendix-daily-values ` +
      `with ${siaDryRun.summary.importedValueCount} SIA-imported entries. All imported entries will be ` +
      `marked anchored (locked from future recompute). Stash keys will be created for rollback.\n\n` +
      `New YTD: ${siaDryRun.summary.newYtdPct}%\n` +
      `Currently stored YTD: ${siaDryRun.summary.existingYtdPct ?? "n/a"}%\n\n` +
      `Proceed?`
    );
    if (!ok) return;
    const data = await callSiaImport(false);
    if (data) {
      setSiaWriteResult(data);
      setSiaDryRun(null);
      // Refresh appendix ledgers so the Daily Values view reflects
      // the freshly-imported numbers if the user switches back.
      void fetchData();
      // Also refresh the stash list so the rollback section shows
      // the just-created stash at the top.
      void loadStashes();
    }
  }, [callSiaImport, siaDryRun, siaProfile, fetchData]);

  // ── Rollback handlers ───────────────────────────────────────────
  const loadStashes = useCallback(async () => {
    setStashesLoading(true);
    try {
      const res = await fetch("/api/admin/restore-from-stash");
      if (res.ok) {
        const data = await res.json() as { stashes: StashRow[] };
        setStashes(data.stashes || []);
      }
    } catch {
      // silently fail — list just stays empty
    } finally {
      setStashesLoading(false);
    }
  }, []);

  const handleRollback = useCallback(async (timestamp: number) => {
    const target = stashes.find((s) => s.timestamp === timestamp);
    if (!target) return;
    const ok = confirm(
      `Roll back to stash from ${target.date}?\n\n` +
      `This restores pm:pim-performance and pm:appendix-daily-values to the values that existed ` +
      `BEFORE this import. The current state will be stashed under a *.pre-rollback-* key so the ` +
      `rollback itself is reversible.\n\n` +
      `Proceed?`
    );
    if (!ok) return;
    setRollbackError(null);
    setRollbackResult(null);
    try {
      const res = await fetch("/api/admin/restore-from-stash", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timestamp, dryRun: false }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setRollbackError(data.error || `HTTP ${res.status}`);
        return;
      }
      setRollbackResult(data);
      void fetchData();
      void loadStashes();
    } catch (err) {
      setRollbackError(err instanceof Error ? err.message : String(err));
    }
  }, [stashes, fetchData, loadStashes]);

  // Load the stash list when the user switches to the SIA Import tab.
  useEffect(() => {
    if (viewMode === "sia-import") {
      void loadStashes();
    }
  }, [viewMode, loadStashes]);

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
                : viewMode === "transactions"
                ? "Permanent transaction log — every rebalance, buy, sell, and switch"
                : "Upload SIA Charts CSV exports to replace current-year daily values with third-party-tracker data"}
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
          <button
            onClick={() => setViewMode("sia-import")}
            className={`rounded-lg px-4 py-2 text-sm font-semibold transition-colors whitespace-nowrap ${
              viewMode === "sia-import" ? "bg-slate-800 text-white" : "text-slate-500 hover:text-slate-800 hover:bg-slate-50"
            }`}
          >
            SIA Import
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

        {viewMode === "daily" && (
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
        )}
        {viewMode === "transactions" && (
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

        {viewMode === "sia-import" && (
          // ── SIA Import View ─────────────────────────────────
          // Click-through UI for /api/admin/import-third-party-values.
          // Replaces current-year daily values with SIA Charts CSV
          // export. All imported entries anchored on the server.
          <div className="space-y-6">
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-4">
              {/* Profile selector */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                  Profile
                </label>
                <div className="flex gap-2 flex-wrap">
                  {PROFILES.map((p) => (
                    <button
                      key={p.key}
                      onClick={() => {
                        setSiaProfile(p.key as PimProfileType);
                        setSiaDryRun(null);
                        setSiaWriteResult(null);
                      }}
                      className={`rounded-lg px-3 py-1.5 text-sm font-semibold transition-colors ${
                        siaProfile === p.key
                          ? "bg-blue-600 text-white"
                          : "bg-slate-100 text-slate-700 hover:bg-slate-200"
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* File upload */}
              <div>
                <label className="block text-xs font-semibold text-slate-600 uppercase tracking-wider mb-2">
                  CSV file (SIA Charts export)
                </label>
                <input
                  ref={siaFileInputRef}
                  type="file"
                  accept=".csv,text/csv"
                  onChange={handleSiaFile}
                  className="block w-full text-sm text-slate-600 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
                {siaFileName && (
                  <p className="text-xs text-slate-500 mt-2">Loaded: {siaFileName}</p>
                )}
              </div>

              {/* Parsed preview */}
              {siaParsed && (
                <div className="rounded-lg bg-slate-50 p-4 text-sm space-y-1">
                  <div className="font-semibold text-slate-700">Parsed {siaParsed.length} rows</div>
                  {siaParsed.length > 0 && (
                    <>
                      <div className="text-slate-600">
                        First: <span className="font-mono">{siaParsed[0].date}</span> → <span className="font-mono">${siaParsed[0].value.toLocaleString()}</span>
                      </div>
                      <div className="text-slate-600">
                        Last: <span className="font-mono">{siaParsed[siaParsed.length - 1].date}</span> → <span className="font-mono">${siaParsed[siaParsed.length - 1].value.toLocaleString()}</span>
                      </div>
                    </>
                  )}
                  {siaParseWarnings.map((w, i) => (
                    <div key={i} className="text-amber-700 text-xs">⚠ {w}</div>
                  ))}
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={handleSiaDryRun}
                  disabled={!siaParsed || siaLoading}
                  className="rounded-lg bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-900 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {siaLoading ? "Running…" : "Dry Run (preview)"}
                </button>
                <button
                  onClick={handleSiaApply}
                  disabled={!siaDryRun || siaLoading}
                  className="rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {siaLoading ? "Writing…" : "Apply (Write to Redis)"}
                </button>
              </div>

              {siaError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                  <strong>Error:</strong> {siaError}
                </div>
              )}
            </div>

            {/* Dry-run result */}
            {siaDryRun && (
              <div className="rounded-2xl border border-amber-200 bg-amber-50 p-6 shadow-sm space-y-3">
                <h2 className="text-lg font-bold text-amber-900">Dry-run preview — NOT written yet</h2>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Profile</div>
                    <div className="font-semibold text-slate-900">{siaDryRun.summary.profile}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">From date</div>
                    <div className="font-mono text-slate-900">{siaDryRun.summary.fromDate}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">New YTD</div>
                    <div className="font-semibold text-slate-900">{siaDryRun.summary.newYtdPct}%</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Existing YTD (replaced)</div>
                    <div className="font-semibold text-slate-900">{siaDryRun.summary.existingYtdPct ?? "n/a"}%</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Entries imported</div>
                    <div className="font-semibold text-slate-900">{siaDryRun.summary.importedValueCount}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Range</div>
                    <div className="font-mono text-slate-900 text-xs">{siaDryRun.summary.firstImportedDate} → {siaDryRun.summary.lastImportedDate}</div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Anchor (pre-fromDate)</div>
                    <div className="font-mono text-slate-900 text-xs">
                      {siaDryRun.summary.anchorPreValue
                        ? `${siaDryRun.summary.anchorPreValue.date} · $${siaDryRun.summary.anchorPreValue.value.toLocaleString()}`
                        : "none — first day return collapses to 0"}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wider text-amber-800 font-semibold">Pre-fromDate preserved</div>
                    <div className="font-semibold text-slate-900">{siaDryRun.summary.preFromDateEntriesPreserved.appendix} appendix · {siaDryRun.summary.preFromDateEntriesPreserved.perf} perf</div>
                  </div>
                </div>
                <p className="text-xs text-amber-700 pt-1">
                  Review these numbers. If correct, click <strong>Apply</strong> to write. If anything looks off, change profile / file and re-run Dry Run.
                </p>
              </div>
            )}

            {/* Write result */}
            {siaWriteResult && (
              <div className="rounded-2xl border border-emerald-200 bg-emerald-50 p-6 shadow-sm space-y-3">
                <h2 className="text-lg font-bold text-emerald-900">✓ Imported successfully</h2>
                <div className="text-sm text-slate-800">
                  <strong>{siaWriteResult.summary.importedValueCount}</strong> daily values written for{" "}
                  <strong>{siaWriteResult.summary.profile}</strong> covering{" "}
                  <span className="font-mono">{siaWriteResult.summary.firstImportedDate}</span> →{" "}
                  <span className="font-mono">{siaWriteResult.summary.lastImportedDate}</span>.
                </div>
                <div className="text-sm text-slate-800">
                  New YTD: <strong>{siaWriteResult.summary.newYtdPct}%</strong>
                </div>
                {siaWriteResult.stashKeys && (
                  <div className="text-xs text-slate-600 pt-2">
                    Rollback stash keys (if ever needed):
                    <ul className="list-disc list-inside pt-1 font-mono">
                      <li>{siaWriteResult.stashKeys.perf}</li>
                      <li>{siaWriteResult.stashKeys.appendix}</li>
                    </ul>
                  </div>
                )}
                <p className="text-xs text-emerald-700 pt-1">
                  Refresh the PIM Model / PIM Performance pages to see the updated chart.
                </p>
              </div>
            )}

            {/* Rollback section — list of available stashes from prior
                imports, each with a Rollback button. Useful when an
                import produced unexpected numbers. */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-bold text-slate-800">Rollback previous imports</h3>
                <button
                  onClick={() => void loadStashes()}
                  className="text-xs rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600 hover:bg-slate-200 transition-colors"
                >
                  {stashesLoading ? "Loading…" : "Refresh"}
                </button>
              </div>
              <p className="text-xs text-slate-500">
                Every import (and every rollback) writes a stash of the prior state.
                Use this list to undo a recent import if the numbers look wrong.
                Stashes are kept indefinitely in Redis — no auto-pruning yet.
              </p>
              {stashes.length === 0 && !stashesLoading && (
                <div className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500">
                  No import stashes found.
                </div>
              )}
              {stashes.length > 0 && (
                <div className="space-y-2">
                  {stashes.map((s, idx) => (
                    <div key={s.timestamp} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                      <div className="text-xs">
                        <div className="font-mono text-slate-800">{s.date.replace("T", " ").slice(0, 19)} UTC</div>
                        <div className="text-slate-500 mt-0.5">
                          {idx === 0 && <span className="inline-block rounded-full bg-blue-100 text-blue-700 px-1.5 py-0.5 mr-2 font-semibold uppercase text-[9px]">Most Recent</span>}
                          perf: {s.perfSizeBytes ? (s.perfSizeBytes / 1024).toFixed(1) : "?"} KB · appendix: {s.appendixSizeBytes ? (s.appendixSizeBytes / 1024).toFixed(1) : "?"} KB
                          {!s.complete && <span className="text-amber-600 ml-2">⚠ incomplete</span>}
                        </div>
                      </div>
                      <button
                        onClick={() => void handleRollback(s.timestamp)}
                        disabled={!s.complete}
                        className="text-xs rounded-lg bg-amber-600 px-3 py-1.5 font-semibold text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        Rollback to this
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {rollbackError && (
                <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
                  <strong>Error:</strong> {rollbackError}
                </div>
              )}
              {rollbackResult?.ok && rollbackResult.wrote && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800 space-y-1">
                  <div className="font-semibold">✓ Restored to {rollbackResult.restoredFrom?.date.replace("T", " ").slice(0, 19)} UTC</div>
                  <div className="text-xs">
                    Pre-rollback state stashed for re-rollback:
                    <ul className="list-disc list-inside pt-1 font-mono">
                      <li>{rollbackResult.preRollbackStashKeys?.perf}</li>
                      <li>{rollbackResult.preRollbackStashKeys?.appendix}</li>
                    </ul>
                  </div>
                </div>
              )}
            </div>

            {/* Quick reference */}
            <div className="rounded-2xl border border-slate-200 bg-white p-6 text-xs text-slate-500 space-y-1">
              <div className="font-semibold text-slate-700 mb-2 text-sm">Tips</div>
              <div>• Bi-weekly / monthly cadence works well. Each import overwrites the current year&apos;s entries with the freshly exported SIA data.</div>
              <div>• Pre-current-year history is permanently locked. Only this year&apos;s entries get replaced.</div>
              <div>• Include Dec 31 of the prior year in the export so the Jan 2 boundary return is preserved.</div>
              <div>• All imported entries are marked anchored — future <code>update-daily-value</code> runs and PUT writes cannot modify them.</div>
              <div>• Today&apos;s entry is computed live by the daily-update path. Don&apos;t worry about it being in the CSV.</div>
              <div>• Every import creates a rollback stash. If an import produced wrong numbers, scroll up to the rollback section and click <strong>Rollback to this</strong> on the relevant entry.</div>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
