"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import type { ResearchState } from "@/app/lib/defaults";
import type { ResearchRemovalStore } from "@/app/lib/research-removals";
import {
  rankResearch,
  fellOffRows,
  RANKED_LISTS,
  SUGGESTED_MIN_LISTS,
  type RankedRow,
  type RankedListRef,
} from "@/app/lib/research-ranked";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import type { Stock, ScoreKey } from "@/app/lib/types";

/** A promoted name starts unscored — the scoring flow fills it in. */
const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

/** Persisted view prefs (pm:ui-prefs) so the choices survive refreshes AND
 *  sync across devices, same as the Sources page's collapse state. */
const PREF_HIDE_HELD = "research.ranked.hideHeld";
const PREF_MIN_LISTS = "research.ranked.minLists";
const PREF_CCY = "research.ranked.ccy";
/** CollapsibleSection-style pref ("1" = collapsed); default collapsed. */
const PREF_FELL_OFF = "research.ranked.fellOff";

type MinLists = 1 | 2 | 3;
type Ccy = "Both" | "CAD" | "USD";

/** One source citation — plain ink-2 text linking to the source pane. */
function SourceRef({ item: r, bearish = false }: { item: RankedListRef; bearish?: boolean }) {
  return (
    <Link
      href={`/research/sources#${r.railKey}`}
      title={bearish
        ? `${r.label} — bearish, not counted`
        : `${r.label}${r.rank != null ? ` — rank ${r.rank}` : ""}${r.dateAdded ? ` · added ${r.dateAdded}` : ""}. Click to open the source pane.`}
      className={bearish ? "!text-neg line-through hover:underline" : "!text-ink-2 hover:!text-accent hover:underline"}
      onClick={(e) => e.stopPropagation()}
    >
      {r.short}
      {!bearish && r.rank != null && <span className="font-mono text-ink-3"> #{r.rank}</span>}
    </Link>
  );
}

function RankedTable({
  title,
  flag,
  rows,
  onWatch,
  adding,
  resolvedNames,
}: {
  title: string;
  flag: "flagCA" | "flagUS";
  rows: RankedRow[];
  onWatch: (row: RankedRow) => void;
  adding: string | null;
  resolvedNames: Record<string, string>;
}) {
  return (
    <section className="panel">
      <div className="panel-h">
        <span className="text-ink-3"><AppIcon name={flag} size={14} /></span>
        <span className="t">{title}</span>
        <span className="m font-mono">{rows.length}</span>
      </div>
      {rows.length === 0 ? (
        <EmptyState className="!py-8" glyph={<AppIcon name="list" size={18} />} title="No names match" body="Nothing on these lists passes the current filters." />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[760px]">
            <thead>
              <tr>
                <th className="n w-10 !pl-3.5">#</th>
                <th>Ticker</th>
                <th>Name</th>
                <th>Sector</th>
                <th className="n" title="Number of bullish Research-tab lists the name is on">Lists</th>
                <th>Sources</th>
                <th className="n !pr-3.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const suggested = r.listCount >= SUGGESTED_MIN_LISTS;
                const name = r.name || resolvedNames[r.ticker] || "";
                return (
                  <tr key={r.key} className={suggested ? "" : "text-ink-2"}>
                    <td className="n !pl-3.5 text-ink-3">{i + 1}</td>
                    <td>
                      <TickerLink ticker={r.heldTicker ?? r.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(r.ticker)}</TickerLink>
                      {r.bearish.length > 0 && (
                        <span className="ml-1.5 text-[11px] text-neg" title={`Bearish view: ${r.bearish.map((b) => b.label).join(", ")} (not counted)`}>
                          Bearish
                        </span>
                      )}
                    </td>
                    <td className="max-w-[240px] truncate" title={name}>{name || "—"}</td>
                    <td className="text-ink-2">{r.sector || "—"}</td>
                    <td className={`n ${suggested ? "font-medium text-ink" : "text-ink-3"}`} title={suggested ? `On ${r.listCount} lists — qualifies for the Suggested Watchlist` : `On ${r.listCount} list`}>
                      {r.listCount}
                    </td>
                    <td className="!whitespace-normal text-ink-2">
                      <span className="inline-flex flex-wrap items-center gap-x-1">
                        {r.lists.map((l, j) => (
                          <React.Fragment key={l.key}>
                            {j > 0 && <span className="text-ink-faint">·</span>}
                            <SourceRef item={l} />
                          </React.Fragment>
                        ))}
                        {r.bearish.map((l) => (
                          <React.Fragment key={l.key}>
                            {(r.lists.length > 0) && <span className="text-ink-faint">·</span>}
                            <SourceRef item={l} bearish />
                          </React.Fragment>
                        ))}
                      </span>
                    </td>
                    <td className="!pr-3.5 !text-right">
                      {r.held ? (
                        <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-2" title={`Already on the ${r.held}`}>
                          <span className={`dot ${r.held === "Portfolio" ? "bg-pos" : "bg-ink-3"}`} />
                          {r.held}
                        </span>
                      ) : (
                        <button
                          onClick={() => onWatch(r)}
                          disabled={adding === r.ticker}
                          className="text-[12px] text-accent hover:underline disabled:opacity-50"
                          title="Add to the Watchlist directly (skips the Suggested stage)"
                        >
                          {adding === r.ticker ? "Adding…" : "Watch"}
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
      <div className="flex h-8 items-center px-3.5 text-[11.5px] text-ink-3">
        {rows.length} of {rows.length} · sorted by list count
      </div>
    </section>
  );
}

export default function RankedResearchPage() {
  const { stocks, addStock, uiPrefs, setUiPref } = useStocks();
  const [research, setResearch] = useState<Partial<ResearchState> | null>(null);
  const [removals, setRemovals] = useState<ResearchRemovalStore>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [resolvedNames, setResolvedNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    Promise.all([
      fetch("/api/kv/research", { cache: "no-store" }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`research ${r.status}`)))),
      fetch("/api/kv/research-removals", { cache: "no-store" }).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ])
      .then(([res, rem]) => {
        if (!alive) return;
        setResearch((res?.research ?? {}) as Partial<ResearchState>);
        setRemovals((rem ?? {}) as ResearchRemovalStore);
      })
      .catch((e) => alive && setLoadError(e instanceof Error ? e.message : String(e)));
    return () => { alive = false; };
  }, []);

  const allRows = useMemo(() => (research ? rankResearch(research, stocks) : []), [research, stocks]);
  const fellOff = useMemo(() => fellOffRows(removals, allRows), [removals, allRows]);

  // Names the lists didn't carry (Fundstrat idea lists store ticker only) —
  // resolved once per page load, never written back (this page is read-only
  // against pm:research; the Sources page owns the backfill).
  useEffect(() => {
    const missing = allRows.filter((r) => !r.name && !resolvedNames[r.ticker]).map((r) => r.ticker);
    if (missing.length === 0) return;
    let alive = true;
    (async () => {
      const next: Record<string, string> = {};
      for (let i = 0; i < missing.length; i += 50) {
        const chunk = missing.slice(i, i + 50);
        try {
          const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(chunk.join(","))}`);
          if (!res.ok) continue;
          const data = (await res.json()) as { names?: Record<string, string> };
          for (const [k, v] of Object.entries(data.names ?? {})) if (v?.trim()) next[k] = v.trim();
        } catch { /* leave blank */ }
      }
      // Mark the rest as looked-up (empty) so we don't refetch every render.
      for (const t of missing) if (!(t in next)) next[t] = "";
      if (alive) setResolvedNames((prev) => ({ ...prev, ...next }));
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allRows]);

  const hideHeld = uiPrefs[PREF_HIDE_HELD] === "1";
  const minLists = (Number(uiPrefs[PREF_MIN_LISTS]) || 1) as MinLists;
  const ccy = ((uiPrefs[PREF_CCY] as Ccy) || "Both") as Ccy;
  const fellOffCollapsed = PREF_FELL_OFF in uiPrefs ? uiPrefs[PREF_FELL_OFF] === "1" : true;

  const filtered = useMemo(
    () => allRows.filter((r) => r.listCount >= minLists && (!hideHeld || !r.held)),
    [allRows, minLists, hideHeld],
  );
  const cad = filtered.filter((r) => r.currency === "CAD");
  const usd = filtered.filter((r) => r.currency === "USD");

  const counts = useMemo(() => ({
    total: allRows.length,
    cad: allRows.filter((r) => r.currency === "CAD").length,
    suggested: allRows.filter((r) => r.listCount >= SUGGESTED_MIN_LISTS).length,
    held: allRows.filter((r) => r.held).length,
    listsLoaded: RANKED_LISTS.filter((l) => Array.isArray(research?.[l.key]) && (research?.[l.key] as unknown[]).length > 0).length,
  }), [allRows, research]);

  const addToWatchlist = useCallback(async (row: RankedRow) => {
    if (row.held) return;
    setAdding(row.ticker);
    let name = row.name || resolvedNames[row.ticker] || row.ticker;
    let sector = row.sector || "Technology";
    try {
      const res = await fetch(`/api/company-name?tickers=${encodeURIComponent(row.ticker)}`);
      if (res.ok) {
        const data = await res.json();
        if (data.names?.[row.ticker]) name = data.names[row.ticker];
        if (data.sectors?.[row.ticker]) sector = data.sectors[row.ticker];
      }
    } catch { /* fall back to what the list carried */ }
    const stock: Stock = {
      ticker: row.ticker,
      name,
      bucket: "Watchlist",
      sector,
      beta: 1.0,
      weights: { portfolio: 0 },
      scores: { ...ZERO_SCORES },
      notes: "",
    };
    addStock(stock);
    setAdding(null);
  }, [addStock, resolvedNames]);

  if (loadError) {
    return (
      <main className="min-h-screen bg-ground text-ink">
        <div className="rounded-card border border-neg-border bg-neg-soft px-3.5 py-2.5 text-[12.5px] text-neg">Failed to load research: {loadError}</div>
      </main>
    );
  }
  if (!research) {
    return <main className="min-h-screen bg-ground text-[12.5px] text-ink-3">Loading ranked research…</main>;
  }

  return (
    <main className="min-h-screen bg-ground text-ink overflow-x-hidden">
      <div className="flex flex-col gap-3.5">
        {/* Toolbar — filters first, funnel counts as meta, no title row. */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="seg" title="Minimum number of lists">
            {([1, 2, 3] as MinLists[]).map((n) => (
              <button key={n} onClick={() => setUiPref(PREF_MIN_LISTS, String(n))} className={minLists === n ? "on" : ""} aria-pressed={minLists === n}>
                {n === 1 ? "All" : `${n}+ lists`}
              </button>
            ))}
          </div>
          <div className="seg" title="Currency">
            {(["Both", "CAD", "USD"] as Ccy[]).map((c) => (
              <button key={c} onClick={() => setUiPref(PREF_CCY, c)} className={ccy === c ? "on" : ""} aria-pressed={ccy === c}>{c}</button>
            ))}
          </div>
          <button
            onClick={() => setUiPref(PREF_HIDE_HELD, hideHeld ? "0" : "1")}
            aria-pressed={hideHeld}
            className={`inline-flex h-7 items-center gap-1.5 rounded-control border px-2.5 text-[12.5px] transition-colors ${hideHeld ? "border-accent-border bg-accent-soft text-accent" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}
            title="Hide names already on the Portfolio or Watchlist (persists)"
          >
            <AppIcon name={hideHeld ? "eyeOff" : "eye"} size={13} strokeWidth={2} />
            {hideHeld ? "Held hidden" : "Hide held"}
          </button>
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-ink-3">
            <span><span className="font-mono text-ink">{counts.total}</span> names across <span className="font-mono text-ink">{counts.listsLoaded}</span> lists</span>
            <span className="inline-flex items-center gap-1">
              <AppIcon name="flagCA" size={13} /> <span className="font-mono text-ink">{counts.cad}</span>
              <span className="ml-2 inline-flex items-center gap-1"><AppIcon name="flagUS" size={13} /> <span className="font-mono text-ink">{counts.total - counts.cad}</span></span>
            </span>
            <span title={`Names on ${SUGGESTED_MIN_LISTS}+ lists feed the Suggested Watchlist on the Dashboard`}>
              <span className="font-mono text-ink">{counts.suggested}</span> on {SUGGESTED_MIN_LISTS}+ lists
              <span className="text-ink-faint"> → </span>
              <Link href="/?bucket=Suggested" className="!text-accent hover:underline">Suggested</Link>
            </span>
            <span><span className="font-mono text-ink">{counts.held}</span> held</span>
          </div>
        </div>

        {(ccy === "Both" || ccy === "CAD") && (
          <RankedTable title="Canadian" flag="flagCA" rows={cad} onWatch={addToWatchlist} adding={adding} resolvedNames={resolvedNames} />
        )}
        {(ccy === "Both" || ccy === "USD") && (
          <RankedTable title="US" flag="flagUS" rows={usd} onWatch={addToWatchlist} adding={adding} resolvedNames={resolvedNames} />
        )}

        {/* Fell off — persisted fold (default collapsed, same pref as before). */}
        <section id={PREF_FELL_OFF} className="panel">
          <div className={`panel-h ${fellOffCollapsed ? "border-b-0" : ""}`}>
            <button
              onClick={() => setUiPref(PREF_FELL_OFF, fellOffCollapsed ? "0" : "1")}
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-expanded={!fellOffCollapsed}
            >
              <span className={`text-ink-3 transition-transform ${fellOffCollapsed ? "-rotate-90" : ""}`}><AppIcon name="chevD" size={14} strokeWidth={2} /></span>
              <span className="t">Fell off</span>
              <span className="m font-mono">{fellOff.length}</span>
              <span className="m hidden truncate sm:inline">Dropped from a list in the last 45 days and now on none — a fading name is worth seeing, not forgetting.</span>
            </button>
          </div>
          {!fellOffCollapsed && (
            fellOff.length === 0 ? (
              <EmptyState className="!py-6" glyph={<AppIcon name="check" size={18} />} title="Nothing has fallen off" body="No name dropped off every list in the last 45 days." />
            ) : (
              <div className="overflow-x-auto">
                <table className="data-table min-w-[520px]">
                  <thead>
                    <tr>
                      <th className="!pl-3.5">Ticker</th>
                      <th>Dropped from</th>
                      <th>Last drop</th>
                    </tr>
                  </thead>
                  <tbody>
                    {fellOff.map((f) => (
                      <tr key={f.key}>
                        <td className="!pl-3.5"><TickerLink ticker={f.ticker} className="font-mono font-medium text-ink hover:text-accent hover:underline">{displayTicker(f.ticker)}</TickerLink></td>
                        <td className="!whitespace-normal text-neg">{f.droppedFrom.join(" · ")}</td>
                        <td className="font-mono text-ink-3">{f.lastDroppedOn}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
        </section>
      </div>
    </main>
  );
}
