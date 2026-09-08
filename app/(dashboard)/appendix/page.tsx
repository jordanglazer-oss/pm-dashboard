"use client";

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import type { AppendixModelLedger, AppendixProfileType, PimTransaction, PimPortfolioState, PimProfileType, PimModelGroup } from "@/app/lib/pim-types";
import { AppIcon } from "@/app/components/AppIcon";
import { StatStrip } from "@/app/components/StatStrip";
import { EmptyState } from "@/app/components/EmptyState";

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
  /** Non-blocking pre-flight data-shape checks from the server. Empty
   *  array = nothing suspicious about the file. */
  warnings?: string[];
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
  { key: "conservative", label: "Conservative" },
  { key: "balanced", label: "Balanced" },
  { key: "growth", label: "Growth" },
  { key: "allEquity", label: "All-Equity" },
  { key: "alpha", label: "Alpha" },
];

const PROFILE_LABELS: Record<PimProfileType, string> = {
  conservative: "Conservative",
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

const INPUT = "h-7 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink outline-none placeholder:text-ink-3 focus:border-accent-border";
const SELECT = "h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink-2 outline-none focus:border-accent-border";
const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50";
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white transition-colors hover:bg-ink-2 disabled:cursor-not-allowed disabled:opacity-50";
const BTN_DANGER = "inline-flex h-7 items-center gap-1.5 rounded-control border border-neg-border bg-surface px-2.5 text-[12.5px] text-neg transition-colors hover:bg-neg-soft disabled:cursor-not-allowed disabled:opacity-50";
const LABEL = "mb-1 block text-[11px] text-ink-3";

/** Prev / next page control: two 28px icon buttons around "Page x of y". */
function Pager({ page, total, onChange }: { page: number; total: number; onChange: (p: number) => void }) {
  if (total <= 1) return null;
  const icon = "grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-40";
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-ink-3">
      <button onClick={() => onChange(Math.max(0, page - 1))} disabled={page === 0} className={icon} aria-label="Previous page">
        <AppIcon name="chevL" size={14} />
      </button>
      <span className="whitespace-nowrap">Page {page + 1} of {total}</span>
      <button onClick={() => onChange(Math.min(total - 1, page + 1))} disabled={page >= total - 1} className={icon} aria-label="Next page">
        <AppIcon name="chevR" size={14} />
      </button>
    </div>
  );
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
          if (["conservative", "balanced", "growth", "allEquity", "alpha"].includes(key) && Array.isArray(data[key])) {
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
    const warn = siaDryRun.summary.warnings ?? [];
    const ok = confirm(
      `Confirm WRITE for ${siaProfile.toUpperCase()}?\n\n` +
      (warn.length > 0
        ? `⚠ ${warn.length} DATA CHECK${warn.length > 1 ? "S" : ""} FLAGGED:\n- ${warn.join("\n- ")}\n\n`
        : "") +
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

  const activeProfileLabel = PROFILES.find((p) => p.key === activeTab)?.label ?? activeTab;

  return (
    <main className="text-ink">
      <div className="flex flex-col gap-3.5">
        {/* Toolbar: view switcher · description · right-aligned actions */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={viewMode === "daily" ? "on" : ""} onClick={() => setViewMode("daily")}>
              Daily values
            </button>
            <button type="button" className={viewMode === "transactions" ? "on" : ""} onClick={() => setViewMode("transactions")}>
              Transactions
              {portfolioState && allTransactions.length > 0 && <span className="c">{allTransactions.length.toLocaleString()}</span>}
            </button>
            <button type="button" className={viewMode === "sia-import" ? "on" : ""} onClick={() => setViewMode("sia-import")}>
              SIA import
            </button>
          </div>
          <span className="hidden text-[11.5px] text-ink-3 lg:inline">
            {viewMode === "daily"
              ? "Permanent daily value ledger — immutable historical record for each model"
              : viewMode === "transactions"
              ? "Permanent transaction log — every rebalance, buy, sell, and switch"
              : "Upload SIA Charts CSV exports to replace current-year daily values with third-party-tracker data"}
          </span>
          <div className="ml-auto flex items-center gap-2">
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
                <label htmlFor="appendix-import" className={`${BTN_PRI} cursor-pointer ${importing ? "pointer-events-none opacity-50" : ""}`}>
                  <AppIcon name="upload" size={13} strokeWidth={2} />
                  {importing ? "Importing" : "Import JSON"}
                </label>
              </>
            )}
            {viewMode === "transactions" && allTransactions.length > 0 && (
              <button onClick={exportTransactionsCSV} className={BTN_PRI}>
                <AppIcon name="download" size={13} strokeWidth={2} />
                Export CSV
              </button>
            )}
          </div>
        </div>

        {importStatus && viewMode === "daily" && (
          <div className={`flex items-center gap-2 text-[12.5px] ${importStatus.startsWith("Error") ? "text-neg" : "text-pos"}`}>
            <span className={`dot ${importStatus.startsWith("Error") ? "bg-neg" : "bg-pos"}`} />
            <span>{importStatus}</span>
            <button onClick={() => setImportStatus(null)} className="text-[11.5px] text-ink-3 hover:text-ink">Dismiss</button>
          </div>
        )}

        {viewMode === "daily" && (
          <>
            {/* Profile switcher */}
            <div className="seg w-fit max-w-full overflow-x-auto" role="group" aria-label="Profile">
              {PROFILES.map((p) => {
                const ledger = ledgers.find((l) => l.profile === p.key);
                const count = ledger?.entries.length || 0;
                return (
                  <button key={p.key} type="button" className={activeTab === p.key ? "on" : ""} onClick={() => setActiveTab(p.key)}>
                    {p.label}
                    {count > 0 && <span className="c">{count.toLocaleString()}</span>}
                  </button>
                );
              })}
            </div>

            {loading ? (
              <div className="py-8 text-[12.5px] text-ink-3">Loading</div>
            ) : !activeLedger || allEntries.length === 0 ? (
              <section className="panel">
                <EmptyState
                  glyph={<AppIcon name="doc" size={18} />}
                  title={`No daily values for ${activeProfileLabel}`}
                  body={<>Import a JSON file with an array of <code className="font-mono">{"{ date, value, dailyReturn }"}</code> entries.</>}
                />
              </section>
            ) : (
              <>
                {stats && (
                  <StatStrip
                    cols={7}
                    items={[
                      { label: "Start date", value: formatDate(stats.firstDate) },
                      { label: "End date", value: formatDate(stats.lastDate) },
                      { label: "Trading days", value: stats.totalDays.toLocaleString() },
                      { label: "Start value", value: formatValue(stats.startValue) },
                      { label: "End value", value: formatValue(stats.endValue) },
                      { label: "Total return", value: <span className={stats.totalReturn >= 0 ? "text-pos" : "text-neg"}>{stats.totalReturn >= 0 ? "+" : ""}{stats.totalReturn.toFixed(2)}%</span> },
                      { label: "CAGR", value: <span className={stats.cagr >= 0 ? "text-pos" : "text-neg"}>{stats.cagr >= 0 ? "+" : ""}{stats.cagr.toFixed(2)}%</span> },
                    ]}
                  />
                )}

                <section className="panel">
                  <div className="panel-h flex-wrap py-1.5">
                    <span className="t">Daily values</span>
                    {stats && (
                      <span className="m font-mono">
                        Best <span className="text-pos">{formatDate(stats.bestDay.date)} {formatPct(stats.bestDay.dailyReturn)}</span>
                        {" · "}
                        Worst <span className="text-neg">{formatDate(stats.worstDay.date)} {formatPct(stats.worstDay.dailyReturn)}</span>
                      </span>
                    )}
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={search}
                        onChange={(e) => { setSearch(e.target.value); setPage(0); }}
                        placeholder="Search by date (YYYY-MM-DD)"
                        className={`${INPUT} w-full sm:w-56`}
                      />
                      <Pager page={page} total={totalPages} onChange={setPage} />
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th className="n pl-3.5">#</th>
                          <th>Date</th>
                          <th className="n">Index value</th>
                          <th className="n">Daily return</th>
                          <th>Source</th>
                          <th className="n pr-3.5">Recorded</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageEntries.map((entry, i) => {
                          const globalIdx = allEntries.length - (page * PAGE_SIZE + i);
                          return (
                            <tr key={entry.date}>
                              <td className="n pl-3.5 text-ink-3">{globalIdx}</td>
                              <td className="font-mono">{entry.date}</td>
                              <td className="n font-medium">{formatValue(entry.value)}</td>
                              <td className={`n ${entry.dailyReturn > 0 ? "text-pos" : entry.dailyReturn < 0 ? "text-neg" : "text-ink-3"}`}>
                                {formatPct(entry.dailyReturn)}
                              </td>
                              <td className="text-ink-2">{entry.date < "2026-04-07" ? "SIA" : "PIM"}</td>
                              <td className="n pr-3.5 text-[11.5px] text-ink-3">
                                {entry.addedAt ? new Date(entry.addedAt).toLocaleDateString() : "seed"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
                    {sortedEntries.length === 0
                      ? "No entries match"
                      : <>{page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, sortedEntries.length)} of {sortedEntries.length.toLocaleString()} · most recent first</>}
                  </div>
                </section>
              </>
            )}
          </>
        )}

        {viewMode === "transactions" && (
          // ── Transactions View ─────────────────────────────────
          <>
            {txLoading ? (
              <div className="py-8 text-[12.5px] text-ink-3">Loading transactions</div>
            ) : allTransactions.length === 0 ? (
              <section className="panel">
                <EmptyState
                  glyph={<AppIcon name="list" size={18} />}
                  title="No transactions recorded yet"
                  body="Transactions appear here after you rebalance or trade in the PIM portfolio."
                />
              </section>
            ) : (
              <>
                <StatStrip
                  cols={4}
                  items={[
                    { label: "Total transactions", value: txStats.total.toLocaleString() },
                    { label: "Rebalances", value: txStats.rebalances.toLocaleString() },
                    { label: "Settled", value: txStats.settled.toLocaleString() },
                    { label: "Pending", value: <span className={txStats.pending > 0 ? "text-warn" : undefined}>{txStats.pending.toLocaleString()}</span> },
                  ]}
                />

                <section className="panel">
                  <div className="panel-h flex-wrap gap-2 py-1.5">
                    <span className="t">Transactions</span>
                    <div className="ml-auto flex flex-wrap items-center gap-2">
                      <input
                        type="text"
                        value={txSearch}
                        onChange={(e) => { setTxSearch(e.target.value); setTxPage(0); }}
                        placeholder="Search symbol, date, notes"
                        className={`${INPUT} w-full sm:w-52`}
                      />
                      <select
                        value={txProfileFilter}
                        onChange={(e) => { setTxProfileFilter(e.target.value as PimProfileType | "all"); setTxPage(0); }}
                        className={SELECT}
                      >
                        <option value="all">All profiles</option>
                        {PROFILES.map((p) => (
                          <option key={p.key} value={p.key}>{p.label}</option>
                        ))}
                      </select>
                      <select
                        value={txTypeFilter}
                        onChange={(e) => { setTxTypeFilter(e.target.value as typeof txTypeFilter); setTxPage(0); }}
                        className={SELECT}
                      >
                        <option value="all">All types</option>
                        <option value="rebalance">Rebalance</option>
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                        <option value="switch">Switch</option>
                      </select>
                      <select
                        value={txStatusFilter}
                        onChange={(e) => { setTxStatusFilter(e.target.value as typeof txStatusFilter); setTxPage(0); }}
                        className={SELECT}
                      >
                        <option value="all">All status</option>
                        <option value="settled">Settled</option>
                        <option value="pending">Pending</option>
                      </select>
                      {groups.length > 1 && (
                        <select
                          value={txGroupFilter}
                          onChange={(e) => { setTxGroupFilter(e.target.value); setTxPage(0); }}
                          className={SELECT}
                        >
                          <option value="all">All models</option>
                          {groups.map((g) => (
                            <option key={g.id} value={g.id}>{g.name}</option>
                          ))}
                        </select>
                      )}
                      <Pager page={txPage} total={txTotalPages} onChange={setTxPage} />
                    </div>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th className="pl-3.5">Date</th>
                          <th className="hidden md:table-cell">Model</th>
                          <th className="hidden sm:table-cell">Profile</th>
                          <th>Type</th>
                          <th>Symbol</th>
                          <th>Direction</th>
                          <th className="n">Price</th>
                          <th className="n hidden md:table-cell">Target %</th>
                          <th className="n hidden lg:table-cell">Amount (CAD)</th>
                          <th className="pr-3.5">Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pageTransactions.map((t) => {
                          const status = t.status || "settled";
                          const groupName = groupNameById.get(t.groupId) || t.groupId;
                          return (
                            <tr key={t.id}>
                              <td className="pl-3.5">
                                <span className="font-mono">{formatTxDate(t.date)}</span>
                                <span className="ml-1.5 hidden text-[11px] text-ink-3 sm:inline">{new Date(t.date).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}</span>
                              </td>
                              <td className="hidden text-ink-2 md:table-cell">{groupName}</td>
                              <td className="hidden text-ink-2 sm:table-cell">
                                {t.profile ? PROFILE_LABELS[t.profile] : <span className="text-ink-faint">—</span>}
                              </td>
                              <td className="capitalize text-ink-2">{t.type}</td>
                              <td className="font-mono font-medium">{t.symbol}</td>
                              <td className={`capitalize ${t.direction === "buy" ? "text-pos" : "text-neg"}`}>{t.direction}</td>
                              <td className="n">
                                {t.price > 0 ? t.price.toFixed(4) : <span className="text-ink-faint">—</span>}
                              </td>
                              <td className="n hidden text-ink-2 md:table-cell">
                                {(t.targetWeight * 100).toFixed(2)}%
                              </td>
                              <td className="n hidden text-ink-2 lg:table-cell">
                                {t.targetAmount ? `$${t.targetAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : <span className="text-ink-faint">—</span>}
                              </td>
                              <td className="pr-3.5" title={status === "settled" && t.settledAt ? `Settled ${formatTxDateTime(t.settledAt)}` : ""}>
                                <span className={`inline-flex items-center gap-2 ${status === "settled" ? "text-ink-2" : "text-warn"}`}>
                                  <span className={`dot ${status === "settled" ? "bg-ink-faint" : "bg-warn"}`} />
                                  {status === "settled" ? "Settled" : "Pending"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
                    {filteredTransactions.length === 0 ? (
                      "No transactions match your filters"
                    ) : (
                      <>{txPage * TX_PAGE_SIZE + 1}–{Math.min((txPage + 1) * TX_PAGE_SIZE, filteredTransactions.length)} of {filteredTransactions.length.toLocaleString()} · most recent first</>
                    )}
                  </div>
                </section>
              </>
            )}
          </>
        )}

        {viewMode === "sia-import" && (
          // ── SIA Import View ─────────────────────────────────
          // Click-through UI for /api/admin/import-third-party-values.
          // Replaces current-year daily values with SIA Charts CSV
          // export. All imported entries anchored on the server.
          <div className="flex flex-col gap-3.5">
            <section className="panel">
              <div className="panel-h">
                <span className="t">Import SIA Charts export</span>
                <span className="m">replaces current-year daily values · every entry anchored</span>
              </div>
              <div className="flex flex-col gap-4 px-3.5 py-3.5 text-[12.5px]">
                {/* Profile selector */}
                <div>
                  <span className={LABEL}>Profile</span>
                  <div className="seg" role="group" aria-label="Profile">
                    {PROFILES.map((p) => (
                      <button
                        key={p.key}
                        type="button"
                        className={siaProfile === p.key ? "on" : ""}
                        onClick={() => {
                          setSiaProfile(p.key as PimProfileType);
                          setSiaDryRun(null);
                          setSiaWriteResult(null);
                        }}
                      >
                        {p.label}
                      </button>
                    ))}
                  </div>
                </div>

                {/* File upload */}
                <div>
                  <label className={LABEL}>CSV file (SIA Charts export)</label>
                  <input
                    ref={siaFileInputRef}
                    type="file"
                    accept=".csv,text/csv"
                    onChange={handleSiaFile}
                    className="block w-full text-[12.5px] text-ink-2 file:mr-3 file:h-7 file:cursor-pointer file:rounded-control file:border file:border-line file:bg-surface file:px-2.5 file:text-[12.5px] file:text-ink-2 hover:file:bg-surface-hover"
                  />
                  {siaFileName && (
                    <p className="mt-1.5 text-[11.5px] text-ink-3">Loaded {siaFileName}</p>
                  )}
                </div>

                {/* Parsed preview */}
                {siaParsed && (
                  <div className="flex flex-col gap-1 rounded-control border border-line-soft bg-surface-2 px-3 py-2">
                    <div className="font-medium text-ink">Parsed {siaParsed.length} rows</div>
                    {siaParsed.length > 0 && (
                      <>
                        <div className="text-ink-2">
                          First <span className="font-mono">{siaParsed[0].date}</span> · <span className="font-mono">${siaParsed[0].value.toLocaleString()}</span>
                        </div>
                        <div className="text-ink-2">
                          Last <span className="font-mono">{siaParsed[siaParsed.length - 1].date}</span> · <span className="font-mono">${siaParsed[siaParsed.length - 1].value.toLocaleString()}</span>
                        </div>
                      </>
                    )}
                    {siaParseWarnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 text-[12px] text-warn"><span className="dot mt-[6px] bg-warn" />{w}</div>
                    ))}
                  </div>
                )}

                {/* Action buttons */}
                <div className="flex flex-wrap gap-2">
                  <button onClick={handleSiaDryRun} disabled={!siaParsed || siaLoading} className={BTN_PRI}>
                    {siaLoading ? "Running" : "Dry run (preview)"}
                  </button>
                  <button onClick={handleSiaApply} disabled={!siaDryRun || siaLoading} className={BTN_DANGER}>
                    {siaLoading ? "Writing" : "Apply (write to Redis)"}
                  </button>
                </div>

                {siaError && (
                  <div className="flex items-start gap-2 text-neg">
                    <span className="dot mt-[6px] bg-neg" />
                    <span><span className="font-medium">Error</span> · {siaError}</span>
                  </div>
                )}
              </div>
            </section>

            {/* Dry-run result */}
            {siaDryRun && (
              <section className="panel">
                <div className="panel-h">
                  <span className="dot bg-warn" />
                  <span className="t">Dry-run preview</span>
                  <span className="m">not written yet</span>
                </div>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-3.5 py-3.5 text-[12.5px] sm:grid-cols-4">
                  {([
                    ["Profile", siaDryRun.summary.profile],
                    ["From date", siaDryRun.summary.fromDate],
                    ["New YTD", `${siaDryRun.summary.newYtdPct}%`],
                    ["Existing YTD (replaced)", `${siaDryRun.summary.existingYtdPct ?? "n/a"}%`],
                    ["Entries imported", String(siaDryRun.summary.importedValueCount)],
                    ["Range", `${siaDryRun.summary.firstImportedDate} to ${siaDryRun.summary.lastImportedDate}`],
                    ["Anchor (pre-fromDate)", siaDryRun.summary.anchorPreValue
                      ? `${siaDryRun.summary.anchorPreValue.date} · $${siaDryRun.summary.anchorPreValue.value.toLocaleString()}`
                      : "none — first day return collapses to 0"],
                    ["Pre-fromDate preserved", `${siaDryRun.summary.preFromDateEntriesPreserved.appendix} appendix · ${siaDryRun.summary.preFromDateEntriesPreserved.perf} perf`],
                  ] as [string, string][]).map(([label, value]) => (
                    <div key={label}>
                      <div className="text-[11px] text-ink-3">{label}</div>
                      <div className="mt-0.5 font-mono text-[12.5px] text-ink">{value}</div>
                    </div>
                  ))}
                </div>
                {siaDryRun.summary.warnings && siaDryRun.summary.warnings.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-line-soft px-3.5 py-3">
                    <div className="text-[11px] text-ink-3">Data checks ({siaDryRun.summary.warnings.length})</div>
                    {siaDryRun.summary.warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 text-[12.5px] leading-[1.45] text-neg"><span className="dot mt-[6px] bg-neg" />{w}</div>
                    ))}
                  </div>
                )}
                <div className="border-t border-line-soft px-3.5 py-2.5 text-[11.5px] text-ink-3">
                  Review these numbers. If correct, click <span className="font-medium text-ink-2">Apply</span> to write. If anything looks off, change profile / file and re-run the dry run.
                </div>
              </section>
            )}

            {/* Write result */}
            {siaWriteResult && (
              <section className="panel">
                <div className="panel-h">
                  <span className="dot bg-pos" />
                  <span className="t">Imported</span>
                  <span className="m">written to Redis</span>
                </div>
                <div className="flex flex-col gap-2 px-3.5 py-3.5 text-[12.5px] text-ink-2">
                  <div>
                    <span className="font-medium text-ink">{siaWriteResult.summary.importedValueCount}</span> daily values written for{" "}
                    <span className="font-medium text-ink">{siaWriteResult.summary.profile}</span> covering{" "}
                    <span className="font-mono">{siaWriteResult.summary.firstImportedDate}</span> to{" "}
                    <span className="font-mono">{siaWriteResult.summary.lastImportedDate}</span>.
                  </div>
                  <div>New YTD <span className="font-mono font-medium text-ink">{siaWriteResult.summary.newYtdPct}%</span></div>
                  {siaWriteResult.stashKeys && (
                    <div className="text-[11.5px] text-ink-3">
                      Rollback stash keys (if ever needed)
                      <ul className="mt-1 list-disc pl-5 font-mono">
                        <li>{siaWriteResult.stashKeys.perf}</li>
                        <li>{siaWriteResult.stashKeys.appendix}</li>
                      </ul>
                    </div>
                  )}
                  <p className="text-[11.5px] text-ink-3">Refresh the PIM Model / PIM Performance pages to see the updated chart.</p>
                </div>
              </section>
            )}

            {/* Rollback section — list of available stashes from prior
                imports, each with a Rollback button. Useful when an
                import produced unexpected numbers. */}
            <section className="panel">
              <div className="panel-h">
                <span className="t">Rollback previous imports</span>
                <span className="m">every import and rollback stashes the prior state</span>
                <button onClick={() => void loadStashes()} className={`${BTN} ml-auto`}>
                  <AppIcon name="refresh" size={13} className={stashesLoading ? "animate-spin" : ""} />
                  {stashesLoading ? "Loading" : "Refresh"}
                </button>
              </div>
              <p className="px-3.5 py-2.5 text-[11.5px] text-ink-3">
                Use this list to undo a recent import if the numbers look wrong. Stashes are kept indefinitely in Redis — no auto-pruning yet.
              </p>
              {stashes.length === 0 && !stashesLoading && (
                <div className="border-t border-line-soft px-3.5 py-3 text-[12.5px] text-ink-3">No import stashes found.</div>
              )}
              {stashes.length > 0 && (
                <div className="overflow-x-auto border-t border-line-soft">
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th className="pl-3.5">Stash</th>
                        <th className="n">Perf</th>
                        <th className="n">Appendix</th>
                        <th>Status</th>
                        <th className="pr-3.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {stashes.map((s, idx) => (
                        <tr key={s.timestamp}>
                          <td className="pl-3.5 font-mono">{s.date.replace("T", " ").slice(0, 19)} UTC</td>
                          <td className="n text-ink-2">{s.perfSizeBytes ? `${(s.perfSizeBytes / 1024).toFixed(1)} KB` : "?"}</td>
                          <td className="n text-ink-2">{s.appendixSizeBytes ? `${(s.appendixSizeBytes / 1024).toFixed(1)} KB` : "?"}</td>
                          <td>
                            <span className={`inline-flex items-center gap-2 ${!s.complete ? "text-warn" : idx === 0 ? "text-accent-ink" : "text-ink-3"}`}>
                              <span className={`dot ${!s.complete ? "bg-warn" : idx === 0 ? "bg-accent" : "bg-ink-faint"}`} />
                              {!s.complete ? "Incomplete" : idx === 0 ? "Most recent" : "Complete"}
                            </span>
                          </td>
                          <td className="pr-3.5 text-right">
                            <button onClick={() => void handleRollback(s.timestamp)} disabled={!s.complete} className={BTN}>
                              Roll back to this
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {rollbackError && (
                <div className="flex items-start gap-2 border-t border-line-soft px-3.5 py-3 text-[12.5px] text-neg">
                  <span className="dot mt-[6px] bg-neg" />
                  <span><span className="font-medium">Error</span> · {rollbackError}</span>
                </div>
              )}
              {rollbackResult?.ok && rollbackResult.wrote && (
                <div className="flex flex-col gap-1 border-t border-line-soft px-3.5 py-3 text-[12.5px]">
                  <div className="flex items-center gap-2 font-medium text-pos">
                    <span className="dot bg-pos" />
                    Restored to {rollbackResult.restoredFrom?.date.replace("T", " ").slice(0, 19)} UTC
                  </div>
                  <div className="text-[11.5px] text-ink-3">
                    Pre-rollback state stashed for re-rollback
                    <ul className="mt-1 list-disc pl-5 font-mono">
                      <li>{rollbackResult.preRollbackStashKeys?.perf}</li>
                      <li>{rollbackResult.preRollbackStashKeys?.appendix}</li>
                    </ul>
                  </div>
                </div>
              )}
            </section>

            {/* Quick reference */}
            <section className="panel">
              <div className="panel-h"><span className="t">Tips</span></div>
              <ul className="flex max-w-[76ch] list-disc flex-col gap-1 py-3 pl-8 pr-3.5 text-[12.5px] leading-[1.5] text-ink-2">
                <li>Bi-weekly / monthly cadence works well. Each import overwrites the current year&apos;s entries with the freshly exported SIA data.</li>
                <li>Pre-current-year history is permanently locked. Only this year&apos;s entries get replaced.</li>
                <li>Include Dec 31 of the prior year in the export so the Jan 2 boundary return is preserved.</li>
                <li>All imported entries are marked anchored — future <code className="font-mono">update-daily-value</code> runs and PUT writes cannot modify them.</li>
                <li>Today&apos;s entry is computed live by the daily-update path. Don&apos;t worry about it being in the CSV.</li>
                <li>Every import creates a rollback stash. If an import produced wrong numbers, use <span className="font-medium text-ink">Roll back to this</span> on the relevant entry above.</li>
              </ul>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}
