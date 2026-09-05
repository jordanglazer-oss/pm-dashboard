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
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
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

type MinLists = 1 | 2 | 3;
type Ccy = "Both" | "CAD" | "USD";

function ListChip({ item: r }: { item: RankedListRef }) {
  return (
    <Link
      href={`/research/sources#${r.railKey}`}
      title={`${r.label}${r.rank != null ? ` — rank ${r.rank}` : ""}${r.dateAdded ? ` · added ${r.dateAdded}` : ""}. Click to open the source pane.`}
      className="rounded bg-accent-soft px-1.5 py-px text-[10px] font-medium !text-accent hover:bg-accent hover:!text-white transition-colors"
      onClick={(e) => e.stopPropagation()}
    >
      {r.short}
      {r.rank != null && <span className="ml-0.5 opacity-70">#{r.rank}</span>}
    </Link>
  );
}

function HeldBadge({ held }: { held: NonNullable<RankedRow["held"]> }) {
  const cls = held === "Portfolio" ? "bg-pos-soft text-pos ring-pos-border" : "bg-warn-soft text-warn ring-warn-border";
  return (
    <span className={`inline-flex items-center rounded-full px-1.5 py-px text-[9px] font-bold uppercase tracking-wide ring-1 ${cls}`} title={`Already on the ${held}`}>
      {held}
    </span>
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
  flag: string;
  rows: RankedRow[];
  onWatch: (row: RankedRow) => void;
  adding: string | null;
  resolvedNames: Record<string, string>;
}) {
  const th = "pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3";
  return (
    <section className="rounded-card border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-base font-bold text-ink">
          <span className="mr-1.5">{flag}</span>{title}
          <span className="ml-2 text-sm font-normal text-ink-3">{rows.length}</span>
        </h2>
      </div>
      {rows.length === 0 ? (
        <p className="py-6 text-center text-xs text-ink-3">No names match the current filters.</p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[760px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={`${th} w-8 text-right`}>#</th>
                <th className={th}>Ticker</th>
                <th className={th}>Name</th>
                <th className={th}>Sector</th>
                <th className={`${th} text-right`} title="Number of bullish Research-tab lists the name is on">Lists</th>
                <th className={th}>Sources</th>
                <th className={`${th} text-right`}>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const suggested = r.listCount >= SUGGESTED_MIN_LISTS;
                const name = r.name || resolvedNames[r.ticker] || "";
                return (
                  <tr key={r.key} className={`border-b border-line-soft hover:bg-surface-hover ${suggested ? "" : "text-ink-2"}`}>
                    <td className="py-2.5 pr-3 text-right font-mono text-[11px] text-ink-3">{i + 1}</td>
                    <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-ink whitespace-nowrap">
                      <TickerLink ticker={r.heldTicker ?? r.ticker}>{displayTicker(r.ticker)}</TickerLink>
                      {r.bearish.length > 0 && (
                        <span
                          className="ml-1.5 rounded-full bg-neg-soft px-1.5 py-px text-[9px] font-bold uppercase text-neg ring-1 ring-neg-border"
                          title={`Bearish view: ${r.bearish.map((b) => b.label).join(", ")} (not counted)`}
                        >
                          Bearish
                        </span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate py-2.5 pr-3 text-ink" title={name}>{name || "—"}</td>
                    <td className="py-2.5 pr-3 text-xs text-ink-2">{r.sector || "—"}</td>
                    <td className="py-2.5 pr-3 text-right">
                      <span className={`inline-flex min-w-[1.6rem] justify-center rounded-md px-1.5 py-0.5 font-mono text-xs font-bold tabular-nums ${suggested ? "bg-accent text-white" : "bg-surface-2 text-ink-2"}`} title={suggested ? `On ${r.listCount} lists — qualifies for the Suggested Watchlist` : `On ${r.listCount} list`}>
                        {r.listCount}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="flex flex-wrap gap-1">
                        {r.lists.map((l) => <ListChip key={l.key} item={l} />)}
                        {r.bearish.map((l) => (
                          <Link
                            key={l.key}
                            href={`/research/sources#${l.railKey}`}
                            className="rounded bg-neg-soft px-1.5 py-px text-[10px] font-medium !text-neg line-through hover:bg-neg hover:!text-white transition-colors"
                            title={`${l.label} — bearish, not counted`}
                          >
                            {l.short}
                          </Link>
                        ))}
                      </span>
                    </td>
                    <td className="py-2.5 text-right whitespace-nowrap">
                      {r.held ? (
                        <HeldBadge held={r.held} />
                      ) : (
                        <button
                          onClick={() => onWatch(r)}
                          disabled={adding === r.ticker}
                          className="rounded bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent hover:bg-accent hover:text-white transition-colors disabled:opacity-50"
                          title="Add to the Watchlist directly (skips the Suggested stage)"
                        >
                          {adding === r.ticker ? "…" : "+ Watch"}
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

  const chip = (active: boolean) =>
    `rounded-[6px] px-2.5 py-1 text-xs font-semibold transition-colors ${active ? "bg-accent text-white" : "text-ink-2 hover:text-ink"}`;

  if (loadError) {
    return (
      <main className="min-h-screen bg-ground px-4 py-6 md:px-8">
        <div className="mx-auto max-w-[88rem] rounded-lg border border-neg-border bg-neg-soft p-4 text-sm text-neg">Failed to load research: {loadError}</div>
      </main>
    );
  }
  if (!research) {
    return <main className="min-h-screen bg-ground px-4 py-6 text-sm text-ink-3 md:px-8"><div className="mx-auto max-w-[88rem]">Loading ranked research…</div></main>;
  }

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-[88rem] space-y-5">
        {/* Funnel strip — where this table sits and what flows out of it. */}
        <section className="rounded-card border border-line bg-white p-4 shadow-card">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-ink-2">
              <span><span className="font-mono font-bold text-ink">{counts.total}</span> names across <span className="font-mono font-bold text-ink">{counts.listsLoaded}</span> lists</span>
              <span>🇨🇦 <span className="font-mono font-bold text-ink">{counts.cad}</span> · 🇺🇸 <span className="font-mono font-bold text-ink">{counts.total - counts.cad}</span></span>
              <span title={`Names on ${SUGGESTED_MIN_LISTS}+ lists feed the Suggested Watchlist on the Dashboard`}>
                <span className="font-mono font-bold text-accent">{counts.suggested}</span> on {SUGGESTED_MIN_LISTS}+ lists → <Link href="/?bucket=Suggested" className="font-semibold !text-accent hover:underline">Suggested</Link>
              </span>
              <span><span className="font-mono font-bold text-ink">{counts.held}</span> already held</span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5" title="Minimum number of lists">
                {([1, 2, 3] as MinLists[]).map((n) => (
                  <button key={n} onClick={() => setUiPref(PREF_MIN_LISTS, String(n))} className={chip(minLists === n)}>
                    {n === 1 ? "All" : `${n}+ lists`}
                  </button>
                ))}
              </span>
              <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5">
                {(["Both", "CAD", "USD"] as Ccy[]).map((c) => (
                  <button key={c} onClick={() => setUiPref(PREF_CCY, c)} className={chip(ccy === c)}>{c}</button>
                ))}
              </span>
              <button
                onClick={() => setUiPref(PREF_HIDE_HELD, hideHeld ? "0" : "1")}
                className={`rounded-control border px-3 py-1.5 text-xs font-semibold transition-colors ${hideHeld ? "border-accent-border bg-accent-soft text-accent" : "border-line text-ink-2 hover:text-ink"}`}
                title="Hide names already on the Portfolio or Watchlist (persists)"
              >
                {hideHeld ? "Held hidden" : "Hide held"}
              </button>
            </div>
          </div>
        </section>

        {(ccy === "Both" || ccy === "CAD") && (
          <RankedTable title="Canadian (CAD)" flag="🇨🇦" rows={cad} onWatch={addToWatchlist} adding={adding} resolvedNames={resolvedNames} />
        )}
        {(ccy === "Both" || ccy === "USD") && (
          <RankedTable title="US (USD)" flag="🇺🇸" rows={usd} onWatch={addToWatchlist} adding={adding} resolvedNames={resolvedNames} />
        )}

        <CollapsibleSection
          prefKey="research.ranked.fellOff"
          defaultCollapsed
          title={<span>Fell off <span className="ml-1 text-sm font-normal text-ink-3">{fellOff.length}</span></span>}
          subtitle="Dropped from a list in the last 45 days and now on none — a fading name is worth seeing, not forgetting."
        >
          {fellOff.length === 0 ? (
            <p className="py-4 text-center text-xs text-ink-3">Nothing has fallen off recently.</p>
          ) : (
            <div className="max-w-full overflow-x-auto">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th className="pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Ticker</th>
                    <th className="pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Dropped from</th>
                    <th className="pb-2 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3">Last drop</th>
                  </tr>
                </thead>
                <tbody>
                  {fellOff.map((f) => (
                    <tr key={f.key} className="border-b border-line-soft">
                      <td className="py-2 pr-3 font-mono text-xs font-semibold text-ink"><TickerLink ticker={f.ticker}>{displayTicker(f.ticker)}</TickerLink></td>
                      <td className="py-2 pr-3">
                        <span className="flex flex-wrap gap-1">
                          {f.droppedFrom.map((l) => (
                            <span key={l} className="rounded bg-neg-soft px-1.5 py-px text-[10px] font-medium text-neg line-through">{l}</span>
                          ))}
                        </span>
                      </td>
                      <td className="py-2 text-xs text-ink-3">{f.lastDroppedOn}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CollapsibleSection>
      </div>
    </main>
  );
}
