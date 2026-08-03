"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import type { SiaMoverResult } from "@/app/lib/sia-universe-shared";

/**
 * "New this week" — the nomination lane at the top of the Pipeline.
 *
 * The rest of the Pipeline RANKS names that a research list already named, so
 * nothing can reach the PM unless a sell-side house published it first. This
 * lane is the other direction: SIA ranks the full S&P 500 + TSX, so a name
 * climbing that ranking can be nominated even when it appears on NO list and
 * in NO bucket — the only organic path into the funnel.
 *
 * Driven by RANK movement, not SMAX. SMAX is a 0-10 integer, so hundreds of
 * names tie at 8/9/10 and it cannot see movement inside the top tier; rank is
 * continuous. SIA publishes the weekly rank change in the export itself, so
 * this works from the FIRST upload with no baseline week. SMAX is kept as a
 * quality GATE (default >=7) so the list is "already-strong names still
 * improving" rather than junk climbing off the bottom.
 *
 * Held names are dropped — this is an idea lane, not a position monitor.
 * Read-only throughout; renders nothing until a universe export has landed.
 */

type Props = {
  /** Upper-cased tickers already in the book, so owned names can be hidden
   *  and watchlist names can be marked as already-known. */
  portfolioTickers: Set<string>;
  watchlistTickers: Set<string>;
  /** Normalized tickers carried by at least one bullish research list. */
  listTickers: Set<string>;
};

export function NewThisWeek({ portfolioTickers, watchlistTickers, listTickers }: Props) {
  const [data, setData] = useState<SiaMoverResult | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [showAll, setShowAll] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/sia-universe?minWChg=20&minSmax=7", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setData(d as SiaMoverResult);
      })
      .catch(() => {})
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, []);

  const rows = useMemo(() => {
    const movers = data?.movers ?? [];
    return movers
      .filter((m) => !portfolioTickers.has(m.ticker.toUpperCase()))
      .map((m) => {
        const tk = m.ticker.toUpperCase();
        return { ...m, onWatchlist: watchlistTickers.has(tk), onList: listTickers.has(tk) };
      });
  }, [data, portfolioTickers, watchlistTickers, listTickers]);

  // Stay invisible until an export has actually landed — an empty box before
  // the first upload is just noise.
  if (!loaded || !data?.date || rows.length === 0) return null;

  const shown = showAll ? rows : rows.slice(0, 12);
  // The genuinely new ideas: rising, and nobody on the desk is carrying them.
  const unknownCount = rows.filter((r) => !r.onList && !r.onWatchlist).length;

  return (
    <section className="mb-5 overflow-hidden rounded-card border border-line bg-white shadow-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <span className="text-xs font-bold uppercase tracking-[0.22em] text-ink-3">New this week</span>
        <span className="rounded-full border border-pos-border bg-pos-soft px-2 py-0.5 text-[10px] font-bold text-pos">
          {rows.length} climbing
        </span>
        {unknownCount > 0 && (
          <span className="rounded-full border border-accent-border bg-accent-soft px-2 py-0.5 text-[10px] font-bold text-accent">
            {unknownCount} on no list
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-faint">
          SIA {data.date} · {data.universeSize} names
        </span>
      </div>

      <p className="border-b border-line-soft px-4 py-2 text-[11.5px] leading-5 text-ink-3">
        Climbed ≥20 places in SIA&apos;s weekly ranking of the full S&amp;P 500 / TSX, while holding a SMAX of 7+
        (so these are already-strong names still improving, not junk bouncing off the bottom). Names marked{" "}
        <span className="font-semibold text-accent">on no list</span> appear nowhere in your research lists —
        those are the ones this lane exists to surface. Holdings are excluded.
      </p>

      <div className="divide-y divide-line-soft">
        {shown.map((r) => (
          <div key={r.ticker} className="flex items-center gap-3 px-4 py-2">
            <Link
              href={`/stock/${encodeURIComponent(r.ticker)}`}
              className="w-20 shrink-0 font-mono text-[13px] font-semibold text-ink hover:text-accent"
            >
              {displayTicker(r.ticker)}
            </Link>
            <span className="font-mono text-[12px] font-bold text-pos" title="Places climbed in SIA's ranking this week">
              ▲{r.wChg}
            </span>
            <span className="font-mono text-[11px] text-ink-3">
              rank {r.rank}
              {r.smax != null ? ` · SMAX ${r.smax}` : ""}
            </span>
            {r.sector && <span className="truncate text-[11px] text-ink-faint">{r.sector}</span>}
            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              {!r.onList && !r.onWatchlist && (
                <span className="rounded-full border border-accent-border bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent">
                  on no list
                </span>
              )}
              {r.onList && (
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-2">
                  on a list
                </span>
              )}
              {r.onWatchlist && (
                <span className="rounded-full border border-line bg-surface-2 px-2 py-0.5 text-[10px] font-semibold text-ink-2">
                  watchlist
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {rows.length > shown.length && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full border-t border-line px-4 py-2 text-[11px] font-semibold text-accent hover:bg-surface-2"
        >
          Show all {rows.length}
        </button>
      )}
    </section>
  );
}
