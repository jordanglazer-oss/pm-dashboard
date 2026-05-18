"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { InboxEvent } from "@/app/lib/inbox-log";
import type { AnalystReports, AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import { canonicalTicker } from "@/app/lib/ticker";
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
  // pm:analyst-snapshots — holds the FactSet entry (averageTarget,
  // analystCount, asOf) per ticker. We display FactSet target in the
  // coverage checklist alongside RBC/JPM status.
  const [snapshots, setSnapshots] = useState<AnalystSnapshots | null>(null);
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
  const { uiPrefs, setUiPref, stocks } = useStocks();
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
      // Fetch the inbox status (recent events), analyst-reports manifest
      // (per-stock ingestion history), and analyst-snapshots (FactSet
      // average targets) in parallel. Each feeds a different section.
      const [statusRes, reportsRes, snapshotsRes] = await Promise.all([
        fetch(`/api/inbox/status?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/api/kv/analyst-reports?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/api/kv/analyst-snapshots?t=${Date.now()}`, { cache: "no-store" }),
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
      if (snapshotsRes.ok) {
        const snapshotsBody = await snapshotsRes.json();
        const s = snapshotsBody?.snapshots ?? snapshotsBody;
        setSnapshots(s && typeof s === "object" ? (s as AnalystSnapshots) : {});
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
  // canonical-ticker keying.
  const factsetByCanonical = new Map<string, { target: number | null; count: number | null }>();
  if (snapshots) {
    for (const [key, snap] of Object.entries(snapshots)) {
      const canon = canonicalTicker(key);
      if (!snap?.factset) continue;
      factsetByCanonical.set(canon, {
        target: typeof snap.factset.averageTarget === "number" ? snap.factset.averageTarget : null,
        count: typeof snap.factset.analystCount === "number" ? snap.factset.analystCount : null,
      });
    }
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
    };
  });

  const coverageFilter = uiPrefs["inbox.coverageFilter"] || "all"; // all | missing | portfolio | watchlist
  const setCoverageFilter = (val: string) => setUiPref("inbox.coverageFilter", val);
  const filteredCoverage = coverageRows.filter((r) => {
    if (coverageFilter === "all") return true;
    if (coverageFilter === "missing") return !r.hasRbc && !r.hasJpm;
    if (coverageFilter === "portfolio") return r.bucket === "Portfolio";
    if (coverageFilter === "watchlist") return r.bucket === "Watchlist";
    return true;
  }).sort((a, b) => {
    // Sort by: missing first, then by bucket (Portfolio first), then ticker.
    const aMissing = !a.hasRbc && !a.hasJpm ? 0 : 1;
    const bMissing = !b.hasRbc && !b.hasJpm ? 0 : 1;
    if (aMissing !== bMissing) return aMissing - bMissing;
    if (a.bucket !== b.bucket) return a.bucket === "Portfolio" ? -1 : 1;
    return a.displayTicker.localeCompare(b.displayTicker);
  });

  const totalCovered = coverageRows.filter((r) => r.hasRbc || r.hasJpm).length;
  const portfolioCovered = coverageRows.filter((r) => r.bucket === "Portfolio" && (r.hasRbc || r.hasJpm)).length;
  const portfolioTotal = coverageRows.filter((r) => r.bucket === "Portfolio").length;
  const watchlistCovered = coverageRows.filter((r) => r.bucket === "Watchlist" && (r.hasRbc || r.hasJpm)).length;
  const watchlistTotal = coverageRows.filter((r) => r.bucket === "Watchlist").length;
  const missingCount = coverageRows.filter((r) => !r.hasRbc && !r.hasJpm).length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Email Inbox Ingestion</h1>
          <p className="text-sm text-slate-500 mt-1">
            Live log of analyst-report PDFs received via the dfwreports123@gmail.com Apps Script webhook.
          </p>
        </div>
        <div className="flex items-center gap-3">
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

      <div className="grid grid-cols-3 gap-3 mb-6">
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
          <table className="w-full text-sm">
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
        ))}
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
        ) : filteredCoverage.length === 0 ? (
          <p className="text-sm text-slate-400 p-4 italic">
            {coverageFilter === "missing"
              ? "🎉 Every scoreable stock has at least one report. No gaps."
              : "No stocks match this filter."}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Ticker</th>
                <th className="px-3 py-2 text-left">Name</th>
                <th className="px-3 py-2 text-left">Bucket</th>
                <th className="px-3 py-2 text-center w-16">RBC</th>
                <th className="px-3 py-2 text-center w-16">JPM</th>
                <th className="px-3 py-2 text-right w-28" title="FactSet street-consensus average price target. Entered manually on each stock page.">FactSet $</th>
                <th className="px-3 py-2 text-left w-32">Status</th>
              </tr>
            </thead>
            <tbody>
              {filteredCoverage.map((r) => {
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
                    <td className="px-3 py-2 text-right font-mono text-xs">
                      {r.factsetTarget != null ? (
                        <span className="text-slate-700" title={r.factsetCount != null ? `FactSet consensus from ${r.factsetCount} analysts` : "FactSet consensus"}>
                          ${r.factsetTarget.toFixed(2)}
                        </span>
                      ) : (
                        <span className="text-slate-300" title="No FactSet average price target on file. Enter via the analyst panel on the stock page.">—</span>
                      )}
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
          <table className="w-full text-sm">
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
        ))}
      </div>

      <div className="mt-6 rounded-lg border border-blue-100 bg-blue-50 p-4 text-sm">
        <p className="font-semibold text-blue-900 mb-1">How to send a report</p>
        <p className="text-blue-800">
          From any email account, send <span className="font-mono">dfwreports123@gmail.com</span> a message with:
        </p>
        <ul className="mt-2 ml-4 list-disc text-blue-800 text-xs space-y-1">
          <li>
            <span className="font-semibold">Subject:</span> <span className="font-mono">Analyst Report: &lt;TICKER&gt;</span>
            <span className="ml-1 text-blue-700">(e.g. <span className="font-mono">Analyst Report: AVGO</span>)</span>
          </li>
          <li>
            <span className="font-semibold">Attach 1–2 PDFs</span> named <span className="font-mono">&lt;TICKER&gt;_JPM.pdf</span> and/or <span className="font-mono">&lt;TICKER&gt;_RBC.pdf</span>
            <span className="ml-1 text-blue-700">(e.g. <span className="font-mono">AVGO_JPM.pdf</span>, <span className="font-mono">AVGO_RBC.pdf</span>)</span>
            <span className="ml-1 text-blue-700">— filename determines which slot each PDF lands in</span>
          </li>
          <li>The Apps Script polls every 5 minutes — events show up in this log within ~5 min.</li>
          <li>Max ~15 MB per PDF.</li>
          <li className="text-blue-700">
            <span className="italic">Legacy subject format also supported:</span> <span className="font-mono">Analyst Report: &lt;TICKER&gt; &lt;RBC|JPM&gt;</span> with any filename.
          </li>
        </ul>
      </div>
    </div>
  );
}
