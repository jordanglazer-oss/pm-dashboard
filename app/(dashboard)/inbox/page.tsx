"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type { InboxEvent } from "@/app/lib/inbox-log";
import { computeAnalystConsensus, buildConsensusExplanation } from "@/app/lib/analyst-snapshots";
import type { AnalystReports, FactSetEntry, TickerSnapshot } from "@/app/lib/analyst-snapshots";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import { canonicalTicker } from "@/app/lib/ticker";
import {
  mapBoostedAiToAiRating,
  mapSmaxToRelativeStrength,
  consensusLabel,
  consensusToneClass,
  type BoostedAiConsensus,
} from "@/app/lib/external-scoring";
import { applySiaEntries, applyBoostedEntries, applyMarketEdgeRows, type StockPatch } from "@/app/lib/stock-patches";
import { parseMarketEdgeCsv } from "@/app/lib/marketedge-csv";
import { parseSiaCsv } from "@/app/lib/sia-csv";
import { parseBoostedCsv } from "@/app/lib/boosted-csv";
import Link from "next/link";

type Status = {
  events: InboxEvent[];
  configured: boolean;
};

function statusChip(status: InboxEvent["status"]) {
  if (status === "success") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (status === "skipped") return "bg-slate-50 text-slate-600 border-slate-200";
  return "bg-red-50 text-red-700 border-red-200";
}

function fmtBytes(n: number | undefined): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true,
    });
  } catch {
    return iso;
  }
}

/**
 * Reusable collapsible-section header for the Inbox page. The whole header
 * row (including any side content like filter chips) becomes clickable to
 * toggle, except the action area on the right which gets its own
 * stop-propagation wrapper.
 *
 * Collapsed state is owned by the parent and persisted via uiPrefs so it
 * sticks across refreshes and devices.
 */
function CollapsibleHeader({
  collapsed,
  onToggle,
  title,
  meta,
  action,
}: {
  collapsed: boolean;
  onToggle: () => void;
  title: React.ReactNode;
  meta?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="border-b border-slate-100 px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
      <button
        onClick={onToggle}
        className="flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity"
        aria-expanded={!collapsed}
      >
        <svg
          className={`w-3.5 h-3.5 text-slate-400 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</span>
        {meta}
      </button>
      {action && <div onClick={(e) => e.stopPropagation()}>{action}</div>}
    </div>
  );
}

/**
 * Inline-editable numeric input for the Coverage Checklist's FactSet
 * columns. Commits on blur or Enter; sync's local state when the parent
 * value changes (e.g. via a refresh). Treats blank as "clear this field"
 * so the user can delete a value by emptying the input.
 *
 * Validates client-side: positive numbers only, NaN ignored. Bad input
 * silently snaps back to the prior value on commit.
 */
function EditableNumberCell({
  value,
  step,
  onCommit,
  width,
  placeholder,
  ariaLabel,
  formatDisplay,
  min,
  max,
}: {
  value: number | null;
  step: string; // e.g. "0.01" or "1"
  onCommit: (next: number | null) => void;
  width: string; // tailwind class
  placeholder?: string;
  ariaLabel: string;
  formatDisplay?: (n: number) => string;
  /** Optional inclusive bounds. When set, the input enforces them via the
   *  native HTML attribute AND the commit handler clamps to the range. */
  min?: number;
  max?: number;
}) {
  // Local string state so the user can type partial values (e.g. "12.")
  // without the parent coercing the value to a number mid-keystroke.
  const [str, setStr] = useState<string>(value != null ? (formatDisplay ? formatDisplay(value) : String(value)) : "");
  const initialRef = useRef(str);

  // Re-sync when parent value changes (e.g. another device edited, or
  // a refresh pulled new data). Skip when the field is focused so we
  // don't yank the value out from under the user mid-type.
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement === inputRef.current) return;
    const next = value != null ? (formatDisplay ? formatDisplay(value) : String(value)) : "";
    setStr(next);
    initialRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const commit = () => {
    if (str === initialRef.current) return; // no change
    const trimmed = str.trim();
    if (trimmed === "") {
      onCommit(null);
      initialRef.current = "";
      return;
    }
    let n = parseFloat(trimmed);
    if (!isFinite(n) || n < 0) {
      // Invalid input — snap back to prior value
      setStr(initialRef.current);
      return;
    }
    // Clamp to optional bounds. Out-of-range inputs are saved as the
    // nearest legal value AND the displayed text updates so the user
    // sees the clamp happen.
    if (typeof min === "number" && n < min) n = min;
    if (typeof max === "number" && n > max) n = max;
    onCommit(n);
    const finalDisplay = formatDisplay ? formatDisplay(n) : String(n);
    setStr(finalDisplay);
    initialRef.current = finalDisplay;
  };

  return (
    <input
      ref={inputRef}
      type="number"
      step={step}
      min={min}
      max={max}
      value={str}
      onChange={(e) => setStr(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setStr(initialRef.current);
          (e.target as HTMLInputElement).blur();
        }
      }}
      placeholder={placeholder ?? "—"}
      aria-label={ariaLabel}
      className={`${width} rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs font-mono text-right outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200 placeholder-slate-300`}
    />
  );
}

/**
 * BoostedAI consensus value as a click-through cycling chip. Each click
 * advances to the next value in the cycle:
 *
 *   — (empty) → Strong Buy → Buy → Hold → Sell → Strong Sell → — → ...
 *
 * Right-click / shift-click reverses the direction (handy for over-shoots).
 * The chip is color-coded by current value via consensusToneClass.
 *
 * Cycling order goes bullish → bearish on left-click. The full cycle
 * (5 values + empty) is 6 states, so worst case the user clicks 5x to
 * reach a target. With shift-click reversing, the actual maximum is 3
 * clicks (cycle is bi-directional, midpoint is 3 from any other state).
 */
function ConsensusButton({
  value,
  onChange,
  ariaLabel,
}: {
  value: BoostedAiConsensus | null;
  onChange: (next: BoostedAiConsensus | null) => void;
  ariaLabel: string;
}) {
  // Cycle order — bullish first since that's the most common starting
  // point when triaging Coverage Checklist entries.
  const cycle: (BoostedAiConsensus | null)[] = [
    null,
    "strong-buy",
    "buy",
    "hold",
    "sell",
    "strong-sell",
  ];
  const idx = value == null ? 0 : Math.max(0, cycle.indexOf(value));
  const advance = (forward: boolean) => {
    const len = cycle.length;
    const next = forward ? (idx + 1) % len : (idx - 1 + len) % len;
    onChange(cycle[next]);
  };

  // Button is locked to w-[68px] + text-[7px] so the Coverage Checklist's
  // Consensus column stays the same width whether the chip shows "BUY" or
  // "STRONG SELL" — otherwise every cycle shifts the entire table.
  return (
    <button
      type="button"
      onClick={(e) => advance(!e.shiftKey)}
      onContextMenu={(e) => {
        e.preventDefault();
        advance(false);
      }}
      aria-label={ariaLabel}
      title="Click to cycle to the next consensus value. Shift-click or right-click to go backwards. Drives aiRating along with the numeric rating."
      className={`inline-flex w-[82px] items-center justify-center rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-all hover:opacity-90 hover:shadow-sm cursor-pointer whitespace-nowrap ${consensusToneClass(value)}`}
    >
      {consensusLabel(value)}
    </button>
  );
}

type ReportsRow = {
  ticker: string;
  source: "rbc" | "jpm";
  date: string; // YYYY-MM-DD or "—"
  dateRaw: string; // ISO timestamp for sorting
  rating: string;
  target: string;
  fileSize: string;
};

export default function InboxPage() {
  const [data, setData] = useState<Status | null>(null);
  // pm:analyst-reports manifest — persistent (not capped at 100 events).
  // Read separately so the "All Ingested Reports" table can show every
  // (ticker, source) slot in the system regardless of how many cached
  // retries have rolled off the event log.
  const [reports, setReports] = useState<AnalystReports | null>(null);
  // pm:analyst-snapshots (which holds FactSet entries) is sourced from
  // StockContext rather than fetched separately here — that way edits to
  // the FactSet target / analyst count below round-trip through the same
  // path the stock page uses, so changes on either side stay in sync
  // without a manual reload.
  const [loading, setLoading] = useState(true);
  // Separate "refreshing" state so the button can show a spinner on manual
  // clicks without flashing the full-page loading state every 15s for the
  // auto-poll. The first load uses `loading`; subsequent loads (auto-poll
  // OR manual refresh button) use `refreshing` for visual feedback.
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  // Hide-cached toggle — defaults to ON because once dedup is working,
  // cached events are mostly noise; the PM cares about fresh ingestions
  // and errors. State persists via uiPrefs (Redis) so the preference
  // sticks across refreshes and syncs across devices.
  const { uiPrefs, setUiPref, stocks, analystSnapshots, getAnalystSnapshot, updateAnalystSnapshot, updateStockFields, updateScore, updateExplanations } = useStocks();
  const hideCached = uiPrefs["inbox.hideCached"] !== "0"; // default true (hidden)
  const toggleHideCached = () => setUiPref("inbox.hideCached", hideCached ? "0" : "1");
  const [error, setError] = useState<string | null>(null);

  // `manual` = true when triggered by the button click, false for auto-poll.
  // Auto-polls don't need to flash the refreshing spinner (no UI affordance),
  // but manual clicks DO so the user gets immediate feedback that the click
  // landed. Cache-busting query param prevents any browser/CDN caching of
  // the /api/inbox/status response.
  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    setError(null);
    try {
      // Fetch the inbox status (recent events) and the analyst-reports
      // manifest (per-stock ingestion history) in parallel.
      const [statusRes, reportsRes] = await Promise.all([
        fetch(`/api/inbox/status?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/api/kv/analyst-reports?t=${Date.now()}`, { cache: "no-store" }),
      ]);
      if (!statusRes.ok) {
        setError(`Failed to load (${statusRes.status})`);
        return;
      }
      setData(await statusRes.json());
      if (reportsRes.ok) {
        const reportsBody = await reportsRes.json();
        const r = reportsBody?.reports ?? reportsBody;
        setReports(r && typeof r === "object" ? (r as AnalystReports) : {});
      }
      setLastUpdated(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      if (manual) setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
    const t = setInterval(() => void load(false), 15000);
    return () => clearInterval(t);
  }, [load]);

  const events = data?.events ?? [];
  const successes = events.filter((e) => e.status === "success").length;
  const failures = events.filter((e) => e.status === "error").length;
  // Cached events are SUCCESS + cached:true (the hash-cache short-circuited
  // the Anthropic call). Once ingestion is steady-state, these are noise —
  // the PM cares about fresh extractions and errors. Filtering happens
  // client-side so the underlying log still contains everything for audit.
  const cachedCount = events.filter((e) => e.status === "success" && e.cached).length;
  const visibleEvents = hideCached
    ? events.filter((e) => !(e.status === "success" && e.cached))
    : events;

  // Flatten the per-ticker manifest into one row per (ticker, source).
  // extractedAt is the date the underlying PDF was originally extracted by
  // Anthropic; it doesn't drift forward on cached retries. Falls back to
  // uploadedAt for legacy entries that predate the extractedAt field.
  const reportRows: ReportsRow[] = [];
  if (reports) {
    for (const ticker of Object.keys(reports)) {
      const tr = reports[ticker];
      if (!tr) continue;
      for (const src of ["rbc", "jpm"] as const) {
        const meta = tr[src];
        if (!meta) continue;
        const dateRaw = meta.extractedAt || meta.uploadedAt || "";
        const date = dateRaw ? dateRaw.slice(0, 10) : "—";
        const rating = meta.extracted?.rating
          ? meta.extracted.rating.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
          : "—";
        const target = typeof meta.extracted?.target === "number"
          ? `$${meta.extracted.target.toFixed(2)}`
          : "—";
        const fileSize = meta.label ? meta.label : `${ticker}_${src.toUpperCase()}.pdf`;
        reportRows.push({ ticker, source: src, date, dateRaw, rating, target, fileSize });
      }
    }
  }
  // Sort: most recently extracted first by default. The user can re-sort
  // via the column header clicks below.
  const reportsSortKey = uiPrefs["inbox.reportsSortKey"] || "date";
  const reportsSortDir = uiPrefs["inbox.reportsSortDir"] || "desc";
  const sortReports = (rows: ReportsRow[]) => {
    const dir = reportsSortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      let cmp = 0;
      switch (reportsSortKey) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "source": cmp = a.source.localeCompare(b.source); break;
        case "rating": cmp = a.rating.localeCompare(b.rating); break;
        case "target": {
          const av = parseFloat(a.target.replace(/[^0-9.-]/g, ""));
          const bv = parseFloat(b.target.replace(/[^0-9.-]/g, ""));
          cmp = (isFinite(av) ? av : -Infinity) - (isFinite(bv) ? bv : -Infinity);
          break;
        }
        case "date":
        default:
          cmp = a.dateRaw.localeCompare(b.dateRaw); break;
      }
      return dir * cmp;
    });
  };
  const sortedReports = sortReports(reportRows);
  const toggleReportsSort = (key: string) => {
    if (reportsSortKey === key) {
      setUiPref("inbox.reportsSortDir", reportsSortDir === "asc" ? "desc" : "asc");
    } else {
      setUiPref("inbox.reportsSortKey", key);
      setUiPref("inbox.reportsSortDir", key === "ticker" || key === "source" ? "asc" : "desc");
    }
  };
  const reportsArrow = (key: string) =>
    reportsSortKey === key ? (reportsSortDir === "asc" ? " ▲" : " ▼") : "";

  // Per-section collapsed state. Each section persists independently via
  // uiPrefs so the user's expand/collapse preferences stick across
  // refreshes and devices. Default for all: expanded.
  const eventsCollapsed = uiPrefs["inbox.section.events.collapsed"] === "1";
  const coverageCollapsed = uiPrefs["inbox.section.coverage.collapsed"] === "1";
  const reportsCollapsed = uiPrefs["inbox.section.reports.collapsed"] === "1";
  const toggleEvents = () => setUiPref("inbox.section.events.collapsed", eventsCollapsed ? "0" : "1");
  const toggleCoverage = () => setUiPref("inbox.section.coverage.collapsed", coverageCollapsed ? "0" : "1");
  const toggleReports = () => setUiPref("inbox.section.reports.collapsed", reportsCollapsed ? "0" : "1");

  // ── Coverage checklist ─────────────────────────────────────────────
  // Cross-reference pm:stocks (portfolio + watchlist) against the
  // pm:analyst-reports manifest to surface coverage gaps. The PM cares
  // about ensuring every scoreable name they're tracking has at least
  // ONE analyst report ingested.
  //
  // Match by canonical ticker so dashboard tickers stored as e.g. "CCO-T"
  // still match analyst-reports keyed as "CCO.TO" (and vice versa).
  type Coverage = {
    ticker: string;
    displayTicker: string;
    name: string;
    bucket: "Portfolio" | "Watchlist";
    hasRbc: boolean;
    hasJpm: boolean;
    /** FactSet street-consensus average price target ($) — manually entered
     *  via the AnalystSnapshotPanel on the stock page. Null when no FactSet
     *  entry has been logged for this ticker yet. */
    factsetTarget: number | null;
    factsetCount: number | null;
    factsetAsOf: string | null;
    /** Raw BoostedAI rating (0-5). Lives on the Stock itself. */
    boostedAi: number | null;
    /** BoostedAI consensus recommendation. */
    boostedAiConsensus: BoostedAiConsensus | null;
    /** Raw SIA score (0-10). Lives on the Stock itself. */
    sia: number | null;
  };
  // Build lookup of canonical-ticker → which sources have reports.
  // Reports manifest itself is keyed by canonical form already, so we just
  // need to canonicalize the stock ticker before lookup.
  const reportsByCanonical = new Map<string, { rbc: boolean; jpm: boolean }>();
  if (reports) {
    for (const [key, tr] of Object.entries(reports)) {
      const canon = canonicalTicker(key);
      if (!tr) continue;
      reportsByCanonical.set(canon, { rbc: !!tr.rbc, jpm: !!tr.jpm });
    }
  }
  // FactSet data lives in pm:analyst-snapshots[ticker].factset — same
  // canonical-ticker keying. We pull from StockContext's analystSnapshots
  // (which mirrors pm:analyst-snapshots and is the same source the stock
  // page reads). When the user edits a FactSet cell below, the edit flows
  // through updateAnalystSnapshot → context state updates → this map
  // recomputes on the next render → row reflects the new value. Same
  // path round-trips persistence to Redis.
  const factsetByCanonical = new Map<string, { target: number | null; count: number | null; asOf: string | null }>();
  for (const [key, snap] of Object.entries(analystSnapshots ?? {})) {
    const canon = canonicalTicker(key);
    if (!snap?.factset) continue;
    factsetByCanonical.set(canon, {
      target: typeof snap.factset.averageTarget === "number" ? snap.factset.averageTarget : null,
      count: typeof snap.factset.analystCount === "number" ? snap.factset.analystCount : null,
      asOf: typeof snap.factset.asOf === "string" ? snap.factset.asOf : null,
    });
  }
  const scoreableStocks = stocks.filter((s) => isScoreable(s) && (s.bucket === "Portfolio" || s.bucket === "Watchlist"));
  const coverageRows: Coverage[] = scoreableStocks.map((s) => {
    const canon = canonicalTicker(s.ticker);
    const has = reportsByCanonical.get(canon);
    const fs = factsetByCanonical.get(canon);
    return {
      ticker: canon,
      displayTicker: s.ticker,
      name: s.name || s.ticker,
      bucket: s.bucket as "Portfolio" | "Watchlist",
      hasRbc: !!has?.rbc,
      hasJpm: !!has?.jpm,
      factsetTarget: fs?.target ?? null,
      factsetCount: fs?.count ?? null,
      factsetAsOf: fs?.asOf ?? null,
      boostedAi: typeof s.boostedAi === "number" ? s.boostedAi : null,
      boostedAiConsensus: s.boostedAiConsensus ?? null,
      sia: typeof s.sia === "number" ? s.sia : null,
    };
  });

  const coverageFilter = uiPrefs["inbox.coverageFilter"] || "all"; // all | missing | portfolio | watchlist
  const setCoverageFilter = (val: string) => setUiPref("inbox.coverageFilter", val);

  // Column sort, persisted via uiPrefs so the preference sticks across
  // refreshes and devices.
  type CoverageSortKey = "ticker" | "name" | "bucket" | "rbc" | "jpm" | "factset" | "analysts" | "boostedAi" | "consensus" | "sia" | "status";
  const covSortKey = (uiPrefs["inbox.coverageSortKey"] as CoverageSortKey) || "status";
  const covSortDir = uiPrefs["inbox.coverageSortDir"] || "asc";
  const toggleCovSort = (key: CoverageSortKey) => {
    if (covSortKey === key) {
      setUiPref("inbox.coverageSortDir", covSortDir === "asc" ? "desc" : "asc");
    } else {
      setUiPref("inbox.coverageSortKey", key);
      // Sensible default: ascending for the new key. The user can flip on
      // a second click. "asc" for status surfaces missing rows first
      // (urgent at the top), which is the most useful default.
      setUiPref("inbox.coverageSortDir", "asc");
    }
  };
  const covArrow = (key: CoverageSortKey) =>
    covSortKey === key ? (covSortDir === "asc" ? " ▲" : " ▼") : "";

  // Filter THEN sort. Comparator handles missing values by floating them
  // to the end of the sort regardless of direction, so an empty FactSet $
  // doesn't accidentally jump to the top of an ascending sort.
  const filteredCoverage = coverageRows.filter((r) => {
    if (coverageFilter === "all") return true;
    if (coverageFilter === "missing") return !r.hasRbc && !r.hasJpm && r.factsetTarget == null;
    if (coverageFilter === "portfolio") return r.bucket === "Portfolio";
    if (coverageFilter === "watchlist") return r.bucket === "Watchlist";
    return true;
  });
  const sortedCoverage = (() => {
    const dir = covSortDir === "asc" ? 1 : -1;
    const cmpNum = (a: number | null, b: number | null): number => {
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    };
    return [...filteredCoverage].sort((a, b) => {
      let cmp = 0;
      switch (covSortKey) {
        case "ticker": cmp = a.displayTicker.localeCompare(b.displayTicker); break;
        case "name": cmp = a.name.localeCompare(b.name); break;
        case "bucket": cmp = a.bucket.localeCompare(b.bucket); break;
        case "rbc": cmp = (a.hasRbc ? 1 : 0) - (b.hasRbc ? 1 : 0); break;
        case "jpm": cmp = (a.hasJpm ? 1 : 0) - (b.hasJpm ? 1 : 0); break;
        case "factset": cmp = cmpNum(a.factsetTarget, b.factsetTarget); break;
        case "analysts": cmp = cmpNum(a.factsetCount, b.factsetCount); break;
        case "boostedAi": cmp = cmpNum(a.boostedAi, b.boostedAi); break;
        case "consensus": {
          // Sort by bullishness: Strong Sell (0) → Sell (1) → Hold (2) → Buy (3) → Strong Buy (4)
          const order: Record<string, number> = { "strong-sell": 0, "sell": 1, "hold": 2, "buy": 3, "strong-buy": 4 };
          const ac = a.boostedAiConsensus ? order[a.boostedAiConsensus] : -1;
          const bc = b.boostedAiConsensus ? order[b.boostedAiConsensus] : -1;
          // Nulls (no consensus) sort to the end regardless of direction
          if (ac < 0 && bc < 0) cmp = 0;
          else if (ac < 0) cmp = 1;
          else if (bc < 0) cmp = -1;
          else cmp = ac - bc;
          break;
        }
        case "sia": cmp = cmpNum(a.sia, b.sia); break;
        case "status":
        default: {
          // Status priority: 0 = no reports (urgent), 1-2 = partial, 3 = all
          // Ascending → urgent first. Descending → all-covered first.
          const score = (r: Coverage) =>
            (r.hasRbc ? 1 : 0) + (r.hasJpm ? 1 : 0) + (r.factsetTarget != null ? 1 : 0);
          cmp = score(a) - score(b);
          // Tie-break on ticker for stability
          if (cmp === 0) cmp = a.displayTicker.localeCompare(b.displayTicker);
          break;
        }
      }
      return dir * cmp;
    });
  })();

  // Commit a FactSet edit for the given ticker. Pull the latest snapshot
  // from context (NOT the closure-captured value, which could be stale),
  // overwrite the factset slot with the new target/count, stamp asOf to
  // today, and call updateAnalystSnapshot. That helper handles canonical-
  // ticker keying and persistence to pm:analyst-snapshots so the stock
  // page reflects the change automatically.
  //
  // When both target and count come back null (user cleared both fields),
  // remove the factset slot entirely. If RBC/JPM are also absent, remove
  // the whole snapshot entry to keep the blob clean.
  const saveFactSet = (ticker: string, target: number | null, count: number | null) => {
    const existing = getAnalystSnapshot(ticker) ?? {};
    const today = new Date().toISOString().slice(0, 10);
    const nowIso = new Date().toISOString();
    let nextFactset: FactSetEntry | undefined;
    if (target == null && count == null) {
      nextFactset = undefined;
    } else {
      // Preserve any fields we don't touch (lastUpdated metadata, etc.)
      // The asOf field auto-stamps to TODAY on every edit per the spec:
      // "the date should default to the date the target price is last
      // changed" — applying it whenever EITHER field is edited (since
      // both are the user's manual entry).
      nextFactset = {
        ...(existing.factset ?? {}),
        ...(target != null ? { averageTarget: target } : { averageTarget: undefined }),
        ...(count != null ? { analystCount: count } : { analystCount: undefined }),
        asOf: today,
        lastUpdated: nowIso,
      };
    }
    const nextSnapshot: TickerSnapshot = { ...existing, factset: nextFactset };
    const anyValue = nextSnapshot.rbc || nextSnapshot.jpm || nextSnapshot.factset;
    updateAnalystSnapshot(ticker, anyValue ? nextSnapshot : undefined);

    // Auto-derive the analystConsensus score + explanation from the updated
    // snapshot, mirroring how BoostedAI/SIA edits auto-derive aiRating
    // and relativeStrength. Uses the stock's current price for the
    // upside component.
    const stock = stocks.find((s) => s.ticker === ticker);
    const price = stock?.price ?? undefined;
    const consensus = computeAnalystConsensus(anyValue ? nextSnapshot : undefined, price);
    updateScore(ticker, "analystConsensus", consensus.score);
    updateExplanations(ticker, { analystConsensus: buildConsensusExplanation(consensus) });
  };

  // Save raw BoostedAI rating (0-5). Also recomputes and writes the
  // derived dashboard aiRating score (0-2) using the current consensus.
  // Falls back to null if both rating + consensus end up missing, in
  // which case the existing manual aiRating is left untouched.
  // Manual edits to BoostedAI / SIA bump *LastReadAt — that's the user's
  // own way of telling the system "this value is current." Clears the
  // post-screenshot warning chip on the stock page.
  const saveBoostedAi = (ticker: string, rating: number | null) => {
    updateStockFields(ticker, {
      boostedAi: rating == null ? undefined : rating,
      boostedLastReadAt: new Date().toISOString(),
    });
    const current = stocks.find((s) => s.ticker === ticker);
    const consensus = current?.boostedAiConsensus ?? null;
    const mapped = mapBoostedAiToAiRating(rating, consensus);
    if (mapped != null) updateScore(ticker, "aiRating", mapped);
  };

  const saveBoostedAiConsensus = (ticker: string, consensus: BoostedAiConsensus | null) => {
    updateStockFields(ticker, {
      boostedAiConsensus: consensus ?? undefined,
      boostedLastReadAt: new Date().toISOString(),
    });
    const current = stocks.find((s) => s.ticker === ticker);
    const rating = current?.boostedAi ?? null;
    const mapped = mapBoostedAiToAiRating(rating, consensus);
    if (mapped != null) updateScore(ticker, "aiRating", mapped);
  };

  const saveSia = (ticker: string, smax: number | null) => {
    updateStockFields(ticker, {
      sia: smax == null ? undefined : smax,
      siaLastReadAt: new Date().toISOString(),
    });
    const mapped = mapSmaxToRelativeStrength(smax);
    if (mapped != null) updateScore(ticker, "relativeStrength", mapped);
  };

  // ── SIA + BoostedAI screenshot importer ───────────────────────────
  // Watchlist screenshots → Anthropic vision → per-stock updates.
  // - Screenshot wins ONLY when it has a value (a row vision couldn't read
  //   leaves the existing manual value alone).
  // - Per-stock chip appears when stock.siaLastScreenshotAt >
  //   stock.siaLastReadAt — i.e. an upload happened that did NOT read a
  //   value for this name. Manual edits clear the chip by bumping
  //   siaLastReadAt. Same for Boosted.
  type ScreenshotImportSummary = {
    source: "sia" | "boosted";
    cached: boolean;
    rowsParsed: number;
    matched: number;
    updated: number;
    inScreenshotButUnreadable: string[]; // tickers vision saw but couldn't parse the value
    expectedButMissing: string[];        // scoreable P+W stocks not in screenshot
    unmatched: string[];                 // tickers in screenshot not in P+W
    errors: string[];
  };
  /** Dispatch a StockPatch[] through the React context. Used by SIA + Boosted
   *  + MarketEdge importers to apply the patches computed by the shared
   *  app/lib/stock-patches helpers. */
  const dispatchPatches = useCallback((patches: StockPatch[]) => {
    for (const p of patches) {
      if (Object.keys(p.fields).length > 0) updateStockFields(p.ticker, p.fields);
      for (const su of p.scoreUpdates ?? []) updateScore(p.ticker, su.key, su.value);
    }
  }, [updateStockFields, updateScore]);
  const [screenshotImportSummary, setScreenshotImportSummary] = useState<ScreenshotImportSummary | null>(null);
  const [siaImporting, setSiaImporting] = useState(false);
  const [boostedImporting, setBoostedImporting] = useState(false);
  const siaFileRef = useRef<HTMLInputElement>(null);
  const siaCsvFileRef = useRef<HTMLInputElement>(null);
  const boostedFileRef = useRef<HTMLInputElement>(null);
  const boostedCsvFileRef = useRef<HTMLInputElement>(null);

  /** Read a File as a base64 data URL — the format the scrape endpoints accept. */
  const fileToDataUrl = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });

  const handleSiaScreenshots = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setSiaImporting(true);
    setScreenshotImportSummary(null);
    const errors: string[] = [];
    try {
      const attachments = await Promise.all(
        Array.from(files).map(async (f) => ({
          id: `sia-${f.name}-${f.size}-${f.lastModified}`,
          label: f.name,
          dataUrl: await fileToDataUrl(f),
        })),
      );
      const res = await fetch("/api/sia-scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`scrape failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      }
      const data = await res.json() as { entries: Array<{ ticker: string; smax?: number }>; cached?: boolean };
      // Expected = scoreable individual stocks in Portfolio + Watchlist
      // (ETFs and funds don't have SIA scores). The shared helper handles
      // the priority rule, dual-listing match, and timestamp bookkeeping.
      const expected = stocks.filter(isScoreable);
      const now = new Date().toISOString();
      // Pass `stocks` (full Portfolio + Watchlist) so any held ETFs/funds
      // in the screenshot drop out of "unmatched" silently — they don't
      // feed relativeStrength so the warning would be misleading.
      const { patches, summary } = applySiaEntries(expected, data.entries || [], now, stocks);
      dispatchPatches(patches);
      setScreenshotImportSummary({
        source: "sia",
        cached: Boolean(data.cached),
        ...summary,
        errors,
      });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      setScreenshotImportSummary({
        source: "sia", cached: false, rowsParsed: 0, matched: 0, updated: 0,
        inScreenshotButUnreadable: [], expectedButMissing: [], unmatched: [], errors,
      });
    } finally {
      setSiaImporting(false);
      if (siaFileRef.current) siaFileRef.current.value = "";
    }
  }, [stocks, dispatchPatches]);

  /** Same priority rule + dual-listing match + held-ETF filter as the
   *  screenshot path — just feeds CSV-parsed rows through the same
   *  applySiaEntries helper. Strictly preferred over the screenshot route
   *  when SIA's CSV export is available: 100% reliable, zero Anthropic
   *  spend, instant. */
  const handleSiaCsv = useCallback(async (file: File) => {
    setSiaImporting(true);
    setScreenshotImportSummary(null);
    try {
      const text = await file.text();
      const parsed = parseSiaCsv(text);
      if (parsed.errors.length > 0) {
        setScreenshotImportSummary({
          source: "sia", cached: false, rowsParsed: 0, matched: 0, updated: 0,
          inScreenshotButUnreadable: [], expectedButMissing: [], unmatched: [],
          errors: parsed.errors,
        });
        return;
      }
      const expected = stocks.filter(isScoreable);
      const now = new Date().toISOString();
      const { patches, summary } = applySiaEntries(expected, parsed.rows, now, stocks);
      dispatchPatches(patches);
      setScreenshotImportSummary({
        source: "sia",
        cached: false,
        ...summary,
        errors: [],
      });
    } catch (e) {
      setScreenshotImportSummary({
        source: "sia", cached: false, rowsParsed: 0, matched: 0, updated: 0,
        inScreenshotButUnreadable: [], expectedButMissing: [], unmatched: [],
        errors: [`Parse failed: ${e instanceof Error ? e.message : String(e)}`],
      });
    } finally {
      setSiaImporting(false);
      if (siaCsvFileRef.current) siaCsvFileRef.current.value = "";
    }
  }, [stocks, dispatchPatches]);

  /** BoostedAI CSV — preferred over the screenshot (more reliable, $0).
   *  Reads the Boosted.ai unified-data export (TICKER + AVERAGE RATING +
   *  CONSENSUS RECOMMENDATION), then feeds the same applyBoostedEntries
   *  helper as the screenshot path. */
  const handleBoostedCsv = useCallback(async (file: File) => {
    setBoostedImporting(true);
    setScreenshotImportSummary(null);
    try {
      const text = await file.text();
      const parsed = parseBoostedCsv(text);
      if (parsed.errors.length > 0) {
        setScreenshotImportSummary({
          source: "boosted", cached: false, rowsParsed: 0, matched: 0, updated: 0,
          inScreenshotButUnreadable: [], expectedButMissing: [], unmatched: [],
          errors: parsed.errors,
        });
        return;
      }
      const expected = stocks.filter(isScoreable);
      const now = new Date().toISOString();
      const { patches, summary } = applyBoostedEntries(expected, parsed.rows, now, stocks);
      dispatchPatches(patches);
      setScreenshotImportSummary({ source: "boosted", cached: false, ...summary, errors: [] });
    } catch (e) {
      setScreenshotImportSummary({
        source: "boosted", cached: false, rowsParsed: 0, matched: 0, updated: 0,
        inScreenshotButUnreadable: [], expectedButMissing: [], unmatched: [],
        errors: [`Parse failed: ${e instanceof Error ? e.message : String(e)}`],
      });
    } finally {
      setBoostedImporting(false);
      if (boostedCsvFileRef.current) boostedCsvFileRef.current.value = "";
    }
  }, [stocks, dispatchPatches]);

  const handleBoostedScreenshots = useCallback(async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setBoostedImporting(true);
    setScreenshotImportSummary(null);
    const errors: string[] = [];
    try {
      const attachments = await Promise.all(
        Array.from(files).map(async (f) => ({
          id: `boosted-${f.name}-${f.size}-${f.lastModified}`,
          label: f.name,
          dataUrl: await fileToDataUrl(f),
        })),
      );
      const res = await fetch("/api/boosted-ai-scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments }),
      });
      if (!res.ok) {
        const t = await res.text();
        throw new Error(`scrape failed (HTTP ${res.status}): ${t.slice(0, 200)}`);
      }
      const data = await res.json() as {
        entries: Array<{ ticker: string; rating?: number; consensus?: BoostedAiConsensus }>;
        cached?: boolean;
      };
      const expected = stocks.filter(isScoreable);
      const now = new Date().toISOString();
      // Pass `stocks` so held ETFs/funds drop out of "unmatched" silently.
      const { patches, summary } = applyBoostedEntries(expected, data.entries || [], now, stocks);
      dispatchPatches(patches);
      setScreenshotImportSummary({
        source: "boosted",
        cached: Boolean(data.cached),
        ...summary,
        errors,
      });
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
      setScreenshotImportSummary({
        source: "boosted", cached: false, rowsParsed: 0, matched: 0, updated: 0,
        inScreenshotButUnreadable: [], expectedButMissing: [], unmatched: [], errors,
      });
    } finally {
      setBoostedImporting(false);
      if (boostedFileRef.current) boostedFileRef.current.value = "";
    }
  }, [stocks, dispatchPatches]);

  // ── MarketEdge ("ChartScout") CSV importer ────────────────────────
  // Weekly upload of the ChartScout Likes export. We pull just the four
  // columns we care about by HEADER NAME (so re-ordered exports keep
  // working): Symbol, Opinion, Score, Power Rating, Opinion Date. Each
  // row is matched against pm:stocks by ticker — with the dual-listing
  // fallback (sameCompanyLoose) so a US "CLS" in the CSV updates a held
  // "CLS.TO" automatically. Each matched stock gets its marketEdge fields
  // refreshed AND its marketEdge composite score recomputed from the new
  // Power Rating (≥0→2, −27..−1→1, <−27→0).
  type MarketEdgeImportSummary = {
    rows: number;
    matched: number;
    updated: number;
    unmatched: string[];
    errors: string[];
  };
  const [marketEdgeImportSummary, setMarketEdgeImportSummary] = useState<MarketEdgeImportSummary | null>(null);
  const [marketEdgeImporting, setMarketEdgeImporting] = useState(false);
  const marketEdgeFileRef = useRef<HTMLInputElement>(null);

  const handleMarketEdgeCsv = useCallback(async (file: File) => {
    setMarketEdgeImporting(true);
    setMarketEdgeImportSummary(null);
    try {
      const text = await file.text();
      const parsed = parseMarketEdgeCsv(text);
      if (parsed.errors.length > 0) {
        setMarketEdgeImportSummary({ rows: 0, matched: 0, updated: 0, unmatched: [], errors: parsed.errors });
        return;
      }
      const { patches, summary } = applyMarketEdgeRows(stocks, parsed.rows);
      dispatchPatches(patches);
      setMarketEdgeImportSummary({
        rows: summary.rowsParsed,
        matched: summary.matched,
        updated: summary.updated,
        unmatched: summary.unmatched,
        errors: [],
      });
    } catch (e) {
      setMarketEdgeImportSummary({
        rows: 0, matched: 0, updated: 0, unmatched: [],
        errors: [`Parse failed: ${e instanceof Error ? e.message : String(e)}`],
      });
    } finally {
      setMarketEdgeImporting(false);
      if (marketEdgeFileRef.current) marketEdgeFileRef.current.value = "";
    }
  }, [stocks, dispatchPatches]);

  const totalCovered = coverageRows.filter((r) => r.hasRbc || r.hasJpm).length;
  const portfolioCovered = coverageRows.filter((r) => r.bucket === "Portfolio" && (r.hasRbc || r.hasJpm)).length;
  const portfolioTotal = coverageRows.filter((r) => r.bucket === "Portfolio").length;
  const watchlistCovered = coverageRows.filter((r) => r.bucket === "Watchlist" && (r.hasRbc || r.hasJpm)).length;
  const watchlistTotal = coverageRows.filter((r) => r.bucket === "Watchlist").length;
  const missingCount = coverageRows.filter((r) => !r.hasRbc && !r.hasJpm).length;

  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">Email Inbox Ingestion</h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Live log of analyst-report PDFs received via the dfwreports123@gmail.com Apps Script webhook.
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Hide-cached toggle. Defaults to ON because cached events are
              just dedup confirmations — the PM cares about fresh ingestions
              and errors. Toggle off temporarily if you want to verify
              specific cache hits. State persists in pm:ui-prefs. */}
          <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={hideCached}
              onChange={toggleHideCached}
              className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-400"
            />
            <span>Hide cached</span>
            {cachedCount > 0 && (
              <span className="text-[10px] text-slate-400">({cachedCount} hidden)</span>
            )}
          </label>
          {lastUpdated && (
            <span className="text-[11px] text-slate-400">
              Updated {lastUpdated.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true })}
            </span>
          )}
          <button
            onClick={() => void load(true)}
            disabled={refreshing}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
          >
            {refreshing && (
              <span className="inline-block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            )}
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6">
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Webhook secret</div>
          <div className="mt-1 text-sm font-semibold">
            {data?.configured ? (
              <span className="text-emerald-700">Configured</span>
            ) : (
              <span className="text-red-700">Missing — set INBOX_SECRET in Vercel</span>
            )}
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Successes (last 100 events)</div>
          <div className="mt-1 text-xl font-bold text-emerald-700">{successes}</div>
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3">
          <div className="text-xs text-slate-500">Failures (last 100 events)</div>
          <div className="mt-1 text-xl font-bold text-red-700">{failures}</div>
        </div>
      </div>

      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        <CollapsibleHeader
          collapsed={eventsCollapsed}
          onToggle={toggleEvents}
          title="Recent Ingestion Events"
          meta={<span className="text-[11px] text-slate-400">{events.length} total · {visibleEvents.length} shown</span>}
        />
        {!eventsCollapsed && (loading && events.length === 0 ? (
          <p className="text-sm text-slate-400 p-4">Loading…</p>
        ) : error ? (
          <p className="text-sm text-red-600 p-4">{error}</p>
        ) : events.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            No ingestion events yet. Once the Apps Script runs and forwards an email, events will appear here.
          </p>
        ) : visibleEvents.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            All {cachedCount} recent event{cachedCount === 1 ? "" : "s"} {cachedCount === 1 ? "is" : "are"} cached re-ingestions (no Anthropic spend, data unchanged). Uncheck &quot;Hide cached&quot; above to see them.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Time</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Ticker · Source</th>
                <th className="px-3 py-2 text-left">Subject / Sender</th>
                <th className="px-3 py-2 text-left">Detail</th>
              </tr>
            </thead>
            <tbody>
              {visibleEvents.map((e) => (
                <tr key={e.id} className="border-t border-slate-100 align-top">
                  <td className="px-3 py-2 whitespace-nowrap text-slate-500 text-xs">{fmtTime(e.receivedAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider ${statusChip(e.status)}`}>
                      {e.status}
                    </span>
                    {e.cached && (
                      <span className="ml-1 inline-block rounded border border-slate-200 bg-slate-50 px-1 py-0.5 text-[9px] font-bold uppercase text-slate-500" title="Hash-gated cache hit — no Anthropic spend">
                        cached
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {e.ticker ? (
                      <span className="font-mono font-semibold text-slate-800">{e.ticker}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                    {e.source && <span className="ml-1 text-[10px] uppercase text-slate-500">{e.source}</span>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-700">
                    {e.subject ? <div className="truncate max-w-[260px]" title={e.subject}>{e.subject}</div> : <div className="text-slate-300">—</div>}
                    {e.sender && <div className="text-[10px] text-slate-400 truncate max-w-[260px]" title={e.sender}>{e.sender}</div>}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {e.message}
                    {e.filename && (
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {e.filename} · {fmtBytes(e.size)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ))}
      </div>

      {/* ── SIA + BoostedAI screenshot importer ──
          Watchlist screenshots → Anthropic vision → per-stock updates.
          Screenshot wins ONLY when it has a value; manual stays otherwise.
          Hash-gated cache (pm:sia-scrape-cache, pm:boosted-ai-scrape-cache)
          so re-uploading an unchanged image costs zero Anthropic tokens. */}
      <div className="mt-6 rounded-lg border border-violet-200 bg-white overflow-hidden">
        <div className="border-b border-violet-100 bg-violet-50/40 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">SIA + BoostedAI — Screenshot upload</h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            Drop a watchlist screenshot from SIACharts or Boosted.ai. Anthropic vision reads the rows and updates every matched ticker (dual-listed names included). A value already on a stock is preserved if the vision can&apos;t read its new value — a yellow chip shows up on that stock&apos;s SIA / BoostedAI input until the next successful read.
          </p>
        </div>
        <div className="grid sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-violet-100">
          {/* SIA upload zone — CSV preferred (instant, $0, 100% reliable);
              screenshot is the fallback when CSV isn't available. */}
          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">SIA watchlist</h3>
              <div className="flex items-center gap-1.5">
                {/* CSV (preferred) */}
                <input
                  ref={siaCsvFileRef}
                  type="file"
                  accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleSiaCsv(f);
                  }}
                  className="hidden"
                  id="sia-csv-input"
                />
                <label
                  htmlFor="sia-csv-input"
                  className={`text-xs font-semibold px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                    siaImporting
                      ? "bg-slate-200 text-slate-500 cursor-wait"
                      : "bg-violet-600 text-white hover:bg-violet-700"
                  }`}
                  title="Preferred: upload the SIA CSV export. 100% reliable, no Anthropic spend, instant."
                >
                  {siaImporting ? "Working…" : "Upload CSV"}
                </label>
                {/* Screenshot (fallback) */}
                <input
                  ref={siaFileRef}
                  type="file"
                  accept="image/*,.pdf,application/pdf"
                  multiple
                  onChange={(e) => void handleSiaScreenshots(e.target.files)}
                  className="hidden"
                  id="sia-screenshot-input"
                />
                <label
                  htmlFor="sia-screenshot-input"
                  className={`text-xs font-semibold px-2.5 py-1.5 rounded-md cursor-pointer border transition-colors ${
                    siaImporting
                      ? "bg-slate-100 text-slate-400 border-slate-200 cursor-wait"
                      : "bg-white text-violet-700 border-violet-300 hover:bg-violet-50"
                  }`}
                  title="Fallback when CSV export isn't available. Vision-parsed; ~95% reliable; one Anthropic call per upload."
                >
                  Screenshot
                </label>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Reads <span className="font-mono">SYM · SMAX</span> per row (CSV) or via vision (screenshot). Updates <code>sia</code> and recomputes the relativeStrength score.
            </p>
          </div>
          {/* BoostedAI upload zone — CSV preferred; screenshot is the fallback. */}
          <div className="p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
              <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wider">BoostedAI watchlist</h3>
              <div className="flex items-center gap-1.5">
                {/* CSV (preferred) */}
                <input
                  ref={boostedCsvFileRef}
                  type="file"
                  accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleBoostedCsv(f);
                  }}
                  className="hidden"
                  id="boosted-csv-input"
                />
                <label
                  htmlFor="boosted-csv-input"
                  className={`text-xs font-semibold px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                    boostedImporting ? "bg-slate-200 text-slate-500 cursor-wait" : "bg-violet-600 text-white hover:bg-violet-700"
                  }`}
                  title="Preferred: the Boosted.ai unified-data CSV export. 100% reliable, no Anthropic spend, instant."
                >
                  {boostedImporting ? "Working…" : "Upload CSV"}
                </label>
                {/* Screenshot (fallback) */}
                <input
                  ref={boostedFileRef}
                  type="file"
                  accept="image/*,.pdf,application/pdf"
                  multiple
                  onChange={(e) => void handleBoostedScreenshots(e.target.files)}
                  className="hidden"
                  id="boosted-screenshot-input"
                />
                <label
                  htmlFor="boosted-screenshot-input"
                  className={`text-xs font-semibold px-2.5 py-1.5 rounded-md cursor-pointer border transition-colors ${
                    boostedImporting ? "bg-slate-100 text-slate-400 border-slate-200 cursor-wait" : "bg-white text-violet-700 border-violet-300 hover:bg-violet-50"
                  }`}
                  title="Fallback when the CSV export isn't handy. Vision-parsed; one Anthropic call per upload."
                >
                  Screenshot
                </label>
              </div>
            </div>
            <p className="text-[10px] text-slate-500">
              Reads <span className="font-mono">TICKER · AVERAGE RATING · CONSENSUS</span> (CSV) or via vision (screenshot). Updates both BoostedAI fields and recomputes the aiRating score.
            </p>
          </div>
        </div>
        {screenshotImportSummary && (
          <div className="px-4 py-3 text-xs space-y-1 border-t border-violet-100 bg-violet-50/20">
            <div className="text-slate-700">
              <span className="font-semibold capitalize">{screenshotImportSummary.source}:</span>{" "}
              <span className="font-semibold">{screenshotImportSummary.matched}</span> matched / {screenshotImportSummary.rowsParsed} rows ·{" "}
              <span className="font-semibold text-emerald-700">{screenshotImportSummary.updated}</span> updated
              {screenshotImportSummary.cached && <span className="ml-1 text-slate-400">(cached, no AI spend)</span>}
            </div>
            {screenshotImportSummary.inScreenshotButUnreadable.length > 0 && (
              <div className="text-amber-700">
                ⚠ In screenshot but value unreadable: <span className="font-mono">{screenshotImportSummary.inScreenshotButUnreadable.join(", ")}</span>
              </div>
            )}
            {screenshotImportSummary.expectedButMissing.length > 0 && (
              <div className="text-amber-700">
                ⚠ Expected scoreable names NOT in screenshot: <span className="font-mono">{screenshotImportSummary.expectedButMissing.join(", ")}</span>
              </div>
            )}
            {screenshotImportSummary.unmatched.length > 0 && (
              <div className="text-slate-500">
                Tickers in screenshot but not in Portfolio/Watchlist: <span className="font-mono">{screenshotImportSummary.unmatched.join(", ")}</span>
              </div>
            )}
            {screenshotImportSummary.errors.length > 0 && (
              <div className="text-red-700">
                {screenshotImportSummary.errors.map((err, i) => <div key={i}>{err}</div>)}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── MarketEdge ("ChartScout") CSV importer ──
          Weekly upload — matches each row's Symbol against pm:stocks (with
          dual-listing fallback) and refreshes the marketEdge fields +
          recomputes the marketEdge composite score from Power Rating. The
          per-stock writes go through updateStockFields / updateScore so
          they persist via the usual debounced pm:stocks PUT (no new key). */}
      <div className="mt-6 rounded-lg border border-indigo-200 bg-white overflow-hidden">
        <div className="border-b border-indigo-100 bg-indigo-50/40 px-4 py-3 flex items-center justify-between flex-wrap gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-800">MarketEdge — Weekly CSV upload</h2>
            <p className="text-[11px] text-slate-500 mt-0.5">
              ChartScout Likes export. Reads <span className="font-mono">Symbol · Opinion · Score · Power Rating · Opinion Date</span> by header (other columns ignored). Matches by ticker — including dual-listed names (US ↔ Canadian). Recomputes the MarketEdge composite score from Power Rating; Opinion + Opinion Score drive the warning flag, not the score.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={marketEdgeFileRef}
              type="file"
              accept=".csv,.tsv,text/csv,text/tab-separated-values,text/plain"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleMarketEdgeCsv(f);
              }}
              className="hidden"
              id="marketedge-csv-input"
            />
            <label
              htmlFor="marketedge-csv-input"
              className={`text-xs font-semibold px-3 py-1.5 rounded-md cursor-pointer transition-colors ${
                marketEdgeImporting
                  ? "bg-slate-200 text-slate-500 cursor-wait"
                  : "bg-indigo-600 text-white hover:bg-indigo-700"
              }`}
            >
              {marketEdgeImporting ? "Importing…" : "Upload CSV"}
            </label>
          </div>
        </div>
        {marketEdgeImportSummary && (
          <div className="px-4 py-3 text-xs space-y-1">
            <div className="text-slate-700">
              <span className="font-semibold">{marketEdgeImportSummary.matched}</span> matched / {marketEdgeImportSummary.rows} rows ·{" "}
              <span className="font-semibold text-emerald-700">{marketEdgeImportSummary.updated}</span> updated
            </div>
            {marketEdgeImportSummary.unmatched.length > 0 && (
              <div className="text-amber-700">
                Unmatched (no Portfolio/Watchlist stock): <span className="font-mono">{marketEdgeImportSummary.unmatched.join(", ")}</span>
              </div>
            )}
            {marketEdgeImportSummary.errors.length > 0 && (
              <div className="text-red-700">
                {marketEdgeImportSummary.errors.map((err, i) => (
                  <div key={i}>{err}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Coverage Checklist ──
          Cross-references pm:stocks against pm:analyst-reports to surface
          gaps: scoreable Portfolio + Watchlist tickers that don't yet have
          a single analyst report ingested. Surfaces the actionable
          "what's still missing" view alongside the activity log. */}
      <div className="mt-6 rounded-lg border border-slate-200 bg-white overflow-hidden">
        <CollapsibleHeader
          collapsed={coverageCollapsed}
          onToggle={toggleCoverage}
          title="Coverage Checklist"
          meta={
            <span className="text-[11px] text-slate-500">
              {totalCovered}/{coverageRows.length} covered ·
              <span className="ml-1">Portfolio {portfolioCovered}/{portfolioTotal}</span> ·
              <span className="ml-1">Watchlist {watchlistCovered}/{watchlistTotal}</span>
              {missingCount > 0 && (
                <span className="ml-2 inline-flex items-center rounded-full bg-red-50 text-red-700 border border-red-200 px-2 py-0.5 text-[10px] font-bold uppercase">
                  {missingCount} missing
                </span>
              )}
            </span>
          }
          action={
            <div className="flex flex-wrap gap-1">
              {[
                { key: "all", label: "All" },
                { key: "missing", label: "Missing only" },
                { key: "portfolio", label: "Portfolio" },
                { key: "watchlist", label: "Watchlist" },
              ].map((b) => (
                <button
                  key={b.key}
                  onClick={() => setCoverageFilter(b.key)}
                  className={`text-[11px] font-semibold rounded-full px-2.5 py-0.5 transition-colors ${
                    coverageFilter === b.key
                      ? "bg-slate-800 text-white"
                      : "bg-slate-100 text-slate-600 hover:bg-slate-200"
                  }`}
                >
                  {b.label}
                </button>
              ))}
            </div>
          }
        />
        {!coverageCollapsed && (coverageRows.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            No scoreable stocks in your Portfolio or Watchlist yet. Add stocks on the Dashboard to start tracking analyst coverage.
          </p>
        ) : sortedCoverage.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            {coverageFilter === "missing"
              ? "🎉 Every scoreable stock has at least one source. No gaps."
              : "No stocks match this filter."}
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("ticker")}>Ticker{covArrow("ticker")}</th>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("name")}>Name{covArrow("name")}</th>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("bucket")}>Bucket{covArrow("bucket")}</th>
                <th className="px-3 py-2 text-center w-16 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("rbc")}>RBC{covArrow("rbc")}</th>
                <th className="px-3 py-2 text-center w-16 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("jpm")}>JPM{covArrow("jpm")}</th>
                <th className="px-3 py-2 text-right w-28 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("factset")} title="FactSet street-consensus average price target. Click the cell value to edit; click the header to sort. Persists to pm:analyst-snapshots — same field shown on the stock page.">FactSet ${covArrow("factset")}</th>
                <th className="px-3 py-2 text-right w-20 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("analysts")} title="Number of analysts in the FactSet consensus. Click the cell value to edit; click the header to sort.">Analysts{covArrow("analysts")}</th>
                <th className="px-3 py-2 text-right w-20 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("boostedAi")} title="Raw BoostedAI rating (0-5, decimals OK). Combined with Consensus to auto-derive the dashboard's aiRating (0-2).">Boosted.ai{covArrow("boostedAi")}</th>
                <th className="px-3 py-2 text-left w-28 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("consensus")} title="BoostedAI consensus recommendation. Combined with the numeric rating to auto-derive aiRating (Strong Buy / Buy → 2, Hold → 1, Sell / Strong Sell → 0).">Consensus{covArrow("consensus")}</th>
                <th className="px-3 py-2 text-right w-20 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("sia")} title="SIA SMAX score (0-10 integer). Maps to relativeStrength: 8-10 → 2, 6-7 → 1, 0-5 → 0.">SIA SMAX{covArrow("sia")}</th>
                <th className="px-3 py-2 text-left w-32 cursor-pointer select-none hover:text-slate-700" onClick={() => toggleCovSort("status")} title="Sort by overall coverage status (No reports / Partial / Both). Ascending shows gaps first.">Status{covArrow("status")}</th>
              </tr>
            </thead>
            <tbody>
              {sortedCoverage.map((r) => {
                const fullyCovered = r.hasRbc && r.hasJpm;
                const partiallyCovered = (r.hasRbc || r.hasJpm) && !fullyCovered;
                const noCoverage = !r.hasRbc && !r.hasJpm;
                return (
                  <tr
                    key={`${r.bucket}-${r.displayTicker}`}
                    className={`border-t border-slate-100 transition-colors ${
                      noCoverage ? "bg-red-50/40 hover:bg-red-50/60" : "hover:bg-slate-50/60"
                    }`}
                  >
                    <td className="px-3 py-2">
                      <Link href={`/stock/${r.displayTicker.toLowerCase()}`} className="font-mono font-semibold text-slate-800 hover:underline">
                        {r.displayTicker}
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600 truncate max-w-[260px]" title={r.name}>{r.name}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                        r.bucket === "Portfolio"
                          ? "bg-blue-50 text-blue-700 border border-blue-200"
                          : "bg-slate-100 text-slate-600 border border-slate-200"
                      }`}>{r.bucket}</span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.hasRbc ? (
                        <span className="inline-block text-emerald-600 font-bold text-base" title="RBC report ingested">✓</span>
                      ) : (
                        <span className="inline-block text-slate-300 text-base" title="No RBC report yet">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      {r.hasJpm ? (
                        <span className="inline-block text-emerald-600 font-bold text-base" title="JPM report ingested">✓</span>
                      ) : (
                        <span className="inline-block text-slate-300 text-base" title="No JPM report yet">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <span className="text-slate-400 text-[10px]">$</span>
                        <EditableNumberCell
                          value={r.factsetTarget}
                          step="0.01"
                          onCommit={(next) => saveFactSet(r.displayTicker, next, r.factsetCount)}
                          width="w-20"
                          placeholder="—"
                          ariaLabel={`FactSet target price for ${r.displayTicker}`}
                          formatDisplay={(n) => n.toFixed(2)}
                        />
                      </div>
                      {r.factsetAsOf && (
                        <div className="text-[9px] text-slate-400 mt-0.5" title="Date the FactSet target was last updated. Auto-stamps to today on every edit.">
                          as of {r.factsetAsOf}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <EditableNumberCell
                        value={r.factsetCount}
                        step="1"
                        onCommit={(next) => saveFactSet(r.displayTicker, r.factsetTarget, next)}
                        width="w-14"
                        placeholder="—"
                        ariaLabel={`Number of analysts for ${r.displayTicker}`}
                        formatDisplay={(n) => String(Math.round(n))}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <EditableNumberCell
                        value={r.boostedAi}
                        step="0.1"
                        min={0}
                        max={5}
                        onCommit={(next) => saveBoostedAi(r.displayTicker, next)}
                        width="w-14"
                        placeholder="—"
                        ariaLabel={`BoostedAI rating for ${r.displayTicker}`}
                        formatDisplay={(n) => n.toFixed(1)}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <ConsensusButton
                        value={r.boostedAiConsensus}
                        ariaLabel={`BoostedAI consensus for ${r.displayTicker}`}
                        onChange={(next) => saveBoostedAiConsensus(r.displayTicker, next)}
                      />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <EditableNumberCell
                        value={r.sia}
                        step="1"
                        min={0}
                        max={10}
                        onCommit={(next) => saveSia(r.displayTicker, next)}
                        width="w-14"
                        placeholder="—"
                        ariaLabel={`SIA SMAX for ${r.displayTicker}`}
                        formatDisplay={(n) => String(Math.round(n))}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <span className={`inline-block rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                        fullyCovered
                          ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                          : partiallyCovered
                          ? "bg-amber-50 text-amber-700 border border-amber-200"
                          : "bg-red-100 text-red-700 border border-red-200"
                      }`}>
                        {fullyCovered ? "Both" : partiallyCovered ? "Partial" : "No reports"}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          </div>
        ))}
      </div>

      {/* ── All Ingested Reports ──
          Permanent per-(ticker, source) view read directly from
          pm:analyst-reports — not capped at 100 like the events log.
          Shows the ORIGINAL extraction date (extractedAt) rather than the
          last-retry date, so cached re-ingestions don't make stale reports
          look freshly processed. */}
      <div className="mt-6 rounded-lg border border-slate-200 bg-white overflow-hidden">
        <CollapsibleHeader
          collapsed={reportsCollapsed}
          onToggle={toggleReports}
          title="All Ingested Reports"
          meta={
            <span className="text-[11px] text-slate-400">
              {reportRows.length} report{reportRows.length === 1 ? "" : "s"} across {new Set(reportRows.map((r) => r.ticker)).size} ticker{new Set(reportRows.map((r) => r.ticker)).size === 1 ? "" : "s"}
            </span>
          }
        />
        {!reportsCollapsed && (reports === null ? (
          <p className="text-sm text-slate-400 p-4">Loading…</p>
        ) : reportRows.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            No reports stored yet. Once any PDF gets fully ingested (via inbox webhook or manual upload), it appears here permanently.
          </p>
        ) : (
          <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleReportsSort("ticker")}>Ticker{reportsArrow("ticker")}</th>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleReportsSort("source")}>Source{reportsArrow("source")}</th>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleReportsSort("date")}>Extracted{reportsArrow("date")}</th>
                <th className="px-3 py-2 text-left cursor-pointer select-none hover:text-slate-700" onClick={() => toggleReportsSort("rating")}>Rating{reportsArrow("rating")}</th>
                <th className="px-3 py-2 text-right cursor-pointer select-none hover:text-slate-700" onClick={() => toggleReportsSort("target")}>Target{reportsArrow("target")}</th>
                <th className="px-3 py-2 text-left">File</th>
              </tr>
            </thead>
            <tbody>
              {sortedReports.map((r) => (
                <tr key={`${r.ticker}-${r.source}`} className="border-t border-slate-100 hover:bg-slate-50/60 transition-colors">
                  <td className="px-3 py-2">
                    <Link href={`/stock/${r.ticker.toLowerCase()}`} className="font-mono font-semibold text-slate-800 hover:underline">
                      {r.ticker}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-xs uppercase tracking-wider text-slate-500">{r.source}</td>
                  <td className="px-3 py-2 text-xs text-slate-700 whitespace-nowrap">{r.date}</td>
                  <td className="px-3 py-2 text-xs">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                      r.rating.toLowerCase().includes("outperform") || r.rating.toLowerCase().includes("overweight")
                        ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                        : r.rating.toLowerCase().includes("underperform") || r.rating.toLowerCase().includes("underweight")
                        ? "bg-red-50 text-red-700 border border-red-200"
                        : r.rating === "—"
                        ? "bg-slate-50 text-slate-400 border border-slate-200"
                        : "bg-amber-50 text-amber-700 border border-amber-200"
                    }`}>
                      {r.rating}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right text-xs font-mono text-slate-700">{r.target}</td>
                  <td className="px-3 py-2 text-xs text-slate-500 truncate max-w-[260px]" title={r.fileSize}>{r.fileSize}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        ))}
      </div>

      {/* ── How to send by email ──
          Single reference table covering every email-routed input the
          Apps Script forwards. Subject prefix → handler is set in
          app/lib/inbox-dispatch.ts (classifySubject); table rows must
          stay in sync if those prefixes change. */}
      <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4">
        <p className="font-semibold text-blue-900 mb-1">How to send by email</p>
        <p className="text-blue-800 text-sm mb-3">
          From any email account, send <span className="font-mono">dfwreports123@gmail.com</span> a message — the subject prefix tells the dashboard what to do with it. Case-insensitive. The Apps Script polls every 5 minutes, so entries appear in the activity log above within ~5 min.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs border-collapse">
            <thead>
              <tr className="border-b border-blue-200 text-left text-blue-900">
                <th className="py-1.5 pr-3 font-semibold whitespace-nowrap">Subject starts with…</th>
                <th className="py-1.5 pr-3 font-semibold whitespace-nowrap">Attach</th>
                <th className="py-1.5 pr-3 font-semibold">What it does</th>
                <th className="py-1.5 font-semibold whitespace-nowrap">Example</th>
              </tr>
            </thead>
            <tbody className="text-blue-800 align-top">
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Analyst Report: &lt;TICKER&gt;</td>
                <td className="py-2 pr-3 whitespace-nowrap">PDF</td>
                <td className="py-2 pr-3">Stores under the ticker&apos;s analyst snapshot. Name each PDF <span className="font-mono">&lt;TICKER&gt;_JPM.pdf</span> or <span className="font-mono">&lt;TICKER&gt;_RBC.pdf</span> to route to the right slot. Max ~15 MB.</td>
                <td className="py-2 font-mono whitespace-nowrap">Analyst Report: AVGO</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">SIA</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className="text-emerald-700 font-semibold">CSV (preferred)</span>
                  <br />or screenshot (PNG/JPG/PDF)
                </td>
                <td className="py-2 pr-3">Reads <span className="font-mono">SYM</span> + <span className="font-mono">SMAX</span> per row. Updates each matched stock&apos;s SMAX and recomputes the SIA score. CSV is auto-detected; held ETFs/funds are skipped silently.</td>
                <td className="py-2 font-mono whitespace-nowrap">SIA — Mar 5</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">BoostedAI <span className="text-blue-500">or</span> Boosted</td>
                <td className="py-2 pr-3 whitespace-nowrap">
                  <span className="text-emerald-700 font-semibold">CSV (preferred)</span>
                  <br />or screenshot (PNG/JPG/PDF)
                </td>
                <td className="py-2 pr-3">Reads <span className="font-mono">TICKER</span> + <span className="font-mono">AVERAGE RATING</span> + <span className="font-mono">CONSENSUS RECOMMENDATION</span> per row. Updates the BoostedAI fields and recomputes the AI Rating score. Send the Boosted.ai unified-data CSV export; held ETFs/funds are skipped silently.</td>
                <td className="py-2 font-mono whitespace-nowrap">BoostedAI watchlist</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">MarketEdge <span className="text-blue-500">or</span> ChartScout</td>
                <td className="py-2 pr-3 whitespace-nowrap">CSV</td>
                <td className="py-2 pr-3">Parses the ChartScout Likes export by header (Symbol / Opinion / Score / Power Rating / Opinion Date). Updates the MarketEdge fields and the MarketEdge composite score.</td>
                <td className="py-2 font-mono whitespace-nowrap">MarketEdge weekly</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Strategist</td>
                <td className="py-2 pr-3 whitespace-nowrap">PDF or image</td>
                <td className="py-2 pr-3">Lands in the Brief&apos;s &ldquo;Analyst / Strategist Reports&rdquo; dropbox — picked up automatically on the next Brief refresh.</td>
                <td className="py-2 font-mono whitespace-nowrap">Strategist note from Newton</td>
              </tr>
              {/* ── Research lists (Fundstrat / RBC / Seeking Alpha / FEW) ── */}
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Fundstrat Top</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the Fundstrat Large-Cap Top Ideas list on the Research tab.</td>
                <td className="py-2 font-mono whitespace-nowrap">Fundstrat Top</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Fundstrat Bottom</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the Fundstrat Large-Cap Bottom Ideas list.</td>
                <td className="py-2 font-mono whitespace-nowrap">Fundstrat Bottom</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Fundstrat SMID Top</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the Fundstrat SMID-Cap Top Ideas list.</td>
                <td className="py-2 font-mono whitespace-nowrap">Fundstrat SMID Top</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Fundstrat SMID Bottom</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the Fundstrat SMID-Cap Bottom Ideas list.</td>
                <td className="py-2 font-mono whitespace-nowrap">Fundstrat SMID Bottom</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">RBC Canadian</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the RBC Canadian Focus List. Tickers auto-canonicalize to <span className="font-mono">.TO</span>.</td>
                <td className="py-2 font-mono whitespace-nowrap">RBC Canadian</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">RBC US</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the RBC US Focus List.</td>
                <td className="py-2 font-mono whitespace-nowrap">RBC US</td>
              </tr>
              <tr className="border-b border-blue-100">
                <td className="py-2 pr-3 font-mono whitespace-nowrap">RBCCM FEW</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the RBCCM Canadian FEW Portfolio list.</td>
                <td className="py-2 font-mono whitespace-nowrap">RBCCM FEW</td>
              </tr>
              <tr>
                <td className="py-2 pr-3 font-mono whitespace-nowrap">Seeking Alpha <span className="text-blue-500">or</span> Alpha Picks</td>
                <td className="py-2 pr-3 whitespace-nowrap">Screenshot (PNG/JPG/PDF)</td>
                <td className="py-2 pr-3">Merges into the Seeking Alpha — Alpha Picks list. Composite ticker+date key so a name can appear on multiple dates.</td>
                <td className="py-2 font-mono whitespace-nowrap">Alpha Picks weekly</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11px] text-blue-700">
          Screenshots from iPhone, Mac, or Windows all work. <span className="italic">Legacy:</span> <span className="font-mono">Analyst Report: &lt;TICKER&gt; &lt;RBC|JPM&gt;</span> with any filename is still supported.
        </p>
      </div>
    </div>
  );
}
