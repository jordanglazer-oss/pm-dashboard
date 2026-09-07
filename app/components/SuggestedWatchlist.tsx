"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
import TickerLink from "@/app/components/TickerLink";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";
import { useTableSort, currencyOf } from "@/app/lib/useTableSort";
import type { ScoreKey } from "@/app/lib/types";
import type { Candidate, CandidateStore } from "@/app/lib/watchlist-candidates";

/** A promoted candidate starts unscored — the scoring flow fills it in. */
const ZERO_SCORES: Record<ScoreKey, number> = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

/* Control vocabulary: 28px toolbar controls; in-row buttons follow the Ideas
   canvas (22px, 11.5px) so they sit inside a 34px row. */
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2 disabled:opacity-50 transition-colors";
const ROW_BTN = "inline-flex h-[22px] items-center gap-1 rounded border border-line bg-surface px-1.5 text-[11.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-50 transition-colors";
const TH_SORT = "cursor-pointer select-none hover:text-ink";

function SortIcon({ col, sortKey, dir }: { col: string; sortKey: string; dir: "asc" | "desc" }) {
  if (col !== sortKey) return null;
  return <AppIcon name={dir === "asc" ? "sortAsc" : "sortDesc"} size={11} className="ml-1 inline-block align-[-1px]" />;
}

/**
 * Suggested Watchlist — names the research sources are nominating, ranked by
 * how many independent lists agree.
 *
 * Shares the Portfolio/Watchlist tile's column rhythm (ticker, sector, price,
 * score) so the three tabs read as one table with different contents. What
 * differs is the score's meaning: here it is CONFLUENCE across sources, not
 * the 41-point composite, so the sources are shown beside it rather than left
 * implicit.
 *
 * Adding a candidate does NOT remove it. A name you already track still
 * carries signal when four sources light up on it, and a list that deleted its
 * own recommendation the moment you acted on it would hide exactly that.
 */
/** Most candidates shown at once. The store keeps every one — fall-off has to
 *  be assessed against the full set or a name pushed past the cap would read as
 *  having dropped off a source it is still on — but 89 rows is not a review
 *  list, it is a spreadsheet. Only the display is capped. */
const MAX_SHOWN = 50;

export function SuggestedWatchlist({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const { stocks, addStock } = useStocks();
  const [store, setStore] = useState<CandidateStore>({ candidates: [] });
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [showFallen, setShowFallen] = useState(false);
  const [ccy, setCcy] = useState<"All" | "CAD" | "USD">("All");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/kv/watchlist-candidates", { cache: "no-store" });
      if (r.ok) {
        const data: CandidateStore = await r.json();
        setStore(data);
        // Tell the tile so the tab chip stops reading 0 after a refresh — it
        // was fetched once on mount and never told the count had changed.
        onCountChange?.(data.candidates.filter((c) => !c.fallenOffAt).length);
      }
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await fetch("/api/watchlist-refresh", { method: "POST" });
      await load();
    } finally {
      setRefreshing(false);
    }
  };

  const held = useCallback(
    (t: string) => stocks.some((s) => s.ticker.toUpperCase().replace(/-T$/, ".TO") === t.toUpperCase().replace(/-T$/, ".TO")),
    [stocks],
  );

  const promote = async (c: Candidate) => {
    setAdding(c.ticker);
    try {
      addStock({
        ticker: c.ticker.toUpperCase(),
        name: c.name,
        bucket: "Watchlist",
        instrumentType: "stock",
        sector: c.sector || "",
        beta: 1.0,
        weights: { portfolio: 0 },
        scores: { ...ZERO_SCORES },
        notes: `From Suggested Watchlist — ${Object.keys(c.sources).join(", ")}`,
      });
    } finally {
      setAdding(null);
    }
  };

  const live = store.candidates.filter((c) => !c.fallenOffAt);
  const fallen = store.candidates.filter((c) => c.fallenOffAt);
  const byState = showFallen ? fallen : live;
  const all = ccy === "All" ? byState : byState.filter((c) => currencyOf(c.ticker) === ccy);

  const { sorted, toggle, key: sortKey, dir: sortDir } = useTableSort(
    all,
    {
      ticker: (c) => c.ticker,
      name: (c) => c.name,
      sector: (c) => c.sector ?? null,
      score: (c) => c.score,
      sources: (c) => Object.keys(c.sources).length,
      seen: (c) => c.fallenOffAt ?? c.firstSeenAt,
    },
    "score",
  );
  const rows = sorted.slice(0, MAX_SHOWN);
  const hidden = sorted.length - rows.length;

  const cadCount = byState.filter((c) => currencyOf(c.ticker) === "CAD").length;
  const usdCount = byState.length - cadCount;

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Movers</span>
        <span className="m">
          {store.generatedAt
            ? `${live.length} live${live.length > MAX_SHOWN ? ` (top ${MAX_SHOWN} shown)` : ""} · ${fallen.length} fallen off · updated ${new Date(store.generatedAt).toLocaleDateString()}`
            : "No refresh yet"}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {/* Currency split. Derived from the ticker suffix — research lists do
              not all publish a currency, and the symbol is what the rest of the
              app keys on anyway. */}
          <div className="seg" title="Currency, from the ticker suffix">
            {(["All", "CAD", "USD"] as const).map((c) => (
              <button key={c} type="button" onClick={() => setCcy(c)} className={ccy === c ? "on" : ""}>
                {c}
                {c !== "All" && <span className="c">{c === "CAD" ? cadCount : usdCount}</span>}
              </button>
            ))}
          </div>
          <div className="seg">
            <button type="button" onClick={() => setShowFallen(false)} className={!showFallen ? "on" : ""}>
              Live <span className="c">{live.length}</span>
            </button>
            <button type="button" onClick={() => setShowFallen(true)} className={showFallen ? "on" : ""}>
              Fallen off <span className="c">{fallen.length}</span>
            </button>
          </div>
          <button type="button" onClick={refresh} disabled={refreshing} className={BTN_PRI}>
            <AppIcon name="refresh" size={13} strokeWidth={2} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      <div className="flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
        <span>Equate rank + SIA relative-strength improvers, weighted by confluence. The research-list funnel is the Suggested tab.</span>
        {!store.generatedAt && <span className="text-ink-2">Run a refresh to assemble candidates from the Equate + SIA exports.</span>}
      </div>

      {loading ? (
        <p className="px-3.5 py-6 text-center text-[12.5px] text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState
          glyph={<AppIcon name="trend" size={16} />}
          title={showFallen ? "Nothing has fallen off yet" : "No candidates yet"}
          body={showFallen ? undefined : "Forward the Equate and SIA files, then hit Refresh."}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th className={`!pl-3.5 ${TH_SORT}`} onClick={() => toggle("ticker")}>Ticker<SortIcon col="ticker" sortKey={sortKey} dir={sortDir} /></th>
                <th className={TH_SORT} onClick={() => toggle("name")}>Name<SortIcon col="name" sortKey={sortKey} dir={sortDir} /></th>
                <th className={TH_SORT} onClick={() => toggle("sector")}>Sector<SortIcon col="sector" sortKey={sortKey} dir={sortDir} /></th>
                <th className={`n ${TH_SORT}`} onClick={() => toggle("score")}>Score<SortIcon col="score" sortKey={sortKey} dir={sortDir} /></th>
                <th className={TH_SORT} onClick={() => toggle("sources")}>Sources<SortIcon col="sources" sortKey={sortKey} dir={sortDir} /></th>
                <th className={TH_SORT} onClick={() => toggle("seen")}>
                  {showFallen ? "Fell off" : "First seen"}<SortIcon col="seen" sortKey={sortKey} dir={sortDir} />
                </th>
                <th className="!text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const delta = c.previousScore == null ? null : c.score - c.previousScore;
                const isNew = !c.fallenOffAt && c.firstSeenAt === store.generatedAt;
                return (
                  <tr key={c.ticker}>
                    <td className="!pl-3.5">
                      <TickerLink ticker={c.ticker} className="font-mono font-medium text-ink hover:underline">{displayTicker(c.ticker)}</TickerLink>
                      {isNew && <span className="ml-2 text-[11px] text-pos">New</span>}
                    </td>
                    <td className="max-w-[220px] truncate" title={c.name}><span className="text-ink-2">{c.name}</span></td>
                    <td><span className="text-ink-2">{c.sector || "—"}</span></td>
                    <td className="n">
                      {c.score}
                      {delta != null && delta !== 0 && (
                        <span className={`ml-1 text-[11px] ${delta > 0 ? "text-pos" : "text-neg"}`}>
                          {delta > 0 ? "+" : ""}{delta}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[12px]">
                        {(c.fallenOffAt ? c.fellFrom ?? [] : Object.keys(c.sources)).map((s, i) => (
                          <React.Fragment key={s}>
                            {i > 0 && <span className="text-ink-faint">·</span>}
                            <span className={c.fallenOffAt ? "text-neg line-through" : "text-ink-2"}>{s.replace("rbc-equate-", "equate-")}</span>
                          </React.Fragment>
                        ))}
                      </span>
                    </td>
                    <td>
                      <span className="text-[12px] text-ink-3">{new Date((c.fallenOffAt ?? c.firstSeenAt) || "").toLocaleDateString()}</span>
                    </td>
                    <td className="!text-right">
                      {held(c.ticker) ? (
                        <span className="text-[11.5px] text-ink-3">Tracked</span>
                      ) : (
                        <button type="button" onClick={() => promote(c)} disabled={adding === c.ticker} className={ROW_BTN}>
                          <AppIcon name="plus" size={11} strokeWidth={2.25} />
                          {adding === c.ticker ? "…" : "Watchlist"}
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

      {!loading && rows.length > 0 && (
        <div className="flex h-8 items-center justify-between gap-3 border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
          <span>{rows.length} of {all.length} · sorted by {sortKey}</span>
          {hidden > 0 ? (
            <span className="truncate">{hidden} more below the top {MAX_SHOWN} — tighten the source cutoffs to bring the list down rather than just hiding them.</span>
          ) : (
            <span className="hidden sm:inline">{cadCount} CAD · {usdCount} USD</span>
          )}
        </div>
      )}
    </section>
  );
}
