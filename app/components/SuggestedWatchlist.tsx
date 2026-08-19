"use client";

import React, { useEffect, useState, useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { displayTicker } from "@/app/lib/ticker";
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

  const { sorted, toggle, arrow } = useTableSort(
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

  const th = "pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3";
  const thSort = `${th} cursor-pointer select-none hover:text-ink`;

  return (
    <div className="rounded-card border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">Suggested Watchlist</h2>
          <p className="text-xs text-ink-3">
            {store.generatedAt
              ? `${live.length} live${live.length > MAX_SHOWN ? ` (top ${MAX_SHOWN} shown)` : ""} · ${fallen.length} fallen off · updated ${new Date(store.generatedAt).toLocaleDateString()}`
              : "No refresh yet — run one to assemble candidates from the ingested sources."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* Currency split. Derived from the ticker suffix — research lists do
              not all publish a currency, and the symbol is what the rest of the
              app keys on anyway. */}
          <span className="inline-flex items-center rounded-control border border-line bg-surface-2 p-0.5">
            {(["All", "CAD", "USD"] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCcy(c)}
                className={`rounded-[6px] px-2.5 py-1 font-semibold transition-colors ${ccy === c ? "bg-accent text-white" : "text-ink-2 hover:text-ink"}`}
              >
                {c}
                {c !== "All" && (
                  <span className={`ml-1 font-normal ${ccy === c ? "text-white/70" : "text-ink-3"}`}>
                    {c === "CAD" ? cadCount : usdCount}
                  </span>
                )}
              </button>
            ))}
          </span>
          <button
            onClick={() => setShowFallen((v) => !v)}
            className={`rounded-control border px-3 py-1.5 font-semibold ${showFallen ? "border-neg-border bg-neg-soft text-neg" : "border-line text-ink-2 hover:text-ink"}`}
          >
            {showFallen ? `Showing fallen off (${fallen.length})` : `Fallen off (${fallen.length})`}
          </button>
          <button
            onClick={refresh}
            disabled={refreshing}
            className="rounded-control bg-accent px-3 py-1.5 font-semibold !text-white disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading ? (
        <p className="py-8 text-center text-xs text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-ink-3">
          {showFallen
            ? "Nothing has fallen off yet."
            : "No candidates yet. Forward the Equate and SIA files, then hit Refresh."}
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={thSort} onClick={() => toggle("ticker")}>Ticker{arrow("ticker")}</th>
                <th className={thSort} onClick={() => toggle("name")}>Name{arrow("name")}</th>
                <th className={thSort} onClick={() => toggle("sector")}>Sector{arrow("sector")}</th>
                <th className={`${thSort} text-right`} onClick={() => toggle("score")}>Score{arrow("score")}</th>
                <th className={thSort} onClick={() => toggle("sources")}>Sources{arrow("sources")}</th>
                <th className={thSort} onClick={() => toggle("seen")}>
                  {showFallen ? "Fell off" : "First seen"}{arrow("seen")}
                </th>
                <th className={`${th} text-right`}>Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const delta = c.previousScore == null ? null : c.score - c.previousScore;
                const isNew = !c.fallenOffAt && c.firstSeenAt === store.generatedAt;
                return (
                  <tr key={c.ticker} className="border-b border-line-soft hover:bg-surface-hover">
                    <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-ink">
                      {displayTicker(c.ticker)}
                      {isNew && (
                        <span className="ml-1.5 rounded-full bg-pos-soft px-1.5 py-px text-[9px] font-bold uppercase text-pos ring-1 ring-pos-border">
                          New
                        </span>
                      )}
                    </td>
                    <td className="max-w-[220px] truncate py-2.5 pr-3 text-ink">{c.name}</td>
                    <td className="py-2.5 pr-3 text-xs text-ink-2">{c.sector || "—"}</td>
                    <td className="py-2.5 pr-3 text-right font-mono font-semibold tabular-nums text-ink">
                      {c.score}
                      {delta != null && delta !== 0 && (
                        <span className={`ml-1 text-[10px] ${delta > 0 ? "text-pos" : "text-neg"}`}>
                          {delta > 0 ? "+" : ""}{delta}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pr-3">
                      <span className="flex flex-wrap gap-1">
                        {(c.fallenOffAt ? c.fellFrom ?? [] : Object.keys(c.sources)).map((s) => (
                          <span
                            key={s}
                            className={`rounded px-1.5 py-px text-[10px] font-medium ${c.fallenOffAt ? "bg-neg-soft text-neg line-through" : "bg-accent-soft text-accent"}`}
                          >
                            {s.replace("rbc-equate-", "equate-")}
                          </span>
                        ))}
                      </span>
                    </td>
                    <td className="py-2.5 pr-3 text-xs text-ink-3">
                      {new Date((c.fallenOffAt ?? c.firstSeenAt) || "").toLocaleDateString()}
                    </td>
                    <td className="py-2.5 text-right">
                      {held(c.ticker) ? (
                        <span className="text-[11px] font-semibold text-ink-faint">Tracked</span>
                      ) : (
                        <button
                          onClick={() => promote(c)}
                          disabled={adding === c.ticker}
                          className="rounded bg-accent-soft px-2 py-1 text-[11px] font-bold text-accent disabled:opacity-50"
                        >
                          {adding === c.ticker ? "…" : "+ Watchlist"}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {hidden > 0 && (
            <p className="pt-2 text-center text-[11px] text-ink-3">
              {hidden} more below the top {MAX_SHOWN} — tighten the source cutoffs to bring the list down rather than just hiding them.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
