"use client";

import { usePersistedOpen } from "@/app/lib/useCollapsed";
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
  const [showAll, toggleShowAll] = usePersistedOpen("newThisWeek.showAll", false);

  useEffect(() => {
    let alive = true;
    fetch("/api/sia-universe?minWChgPct=4&minSmax=7", { cache: "no-store" })
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
    <section className="panel">
      <div className="panel-h">
        <span className="t">New this week</span>
        <span className="m">
          <span className="text-pos">{rows.length} climbing</span>
          {unknownCount > 0 && <> · <span className="text-accent">{unknownCount} on no list</span></>}
        </span>
        <span className="ml-auto font-mono text-[11.5px] text-ink-3">SIA {data.date} · {data.universeSize} names</span>
      </div>

      <p className="border-b border-line-soft px-3.5 py-2 text-[11.5px] leading-5 text-ink-3">
        Climbed ≥20 places in SIA&apos;s weekly ranking of the full S&amp;P 500 / TSX, while holding a SMAX of 7+
        (so these are already-strong names still improving, not junk bouncing off the bottom). Names marked{" "}
        <span className="text-accent">on no list</span> appear nowhere in your research lists —
        those are the ones this lane exists to surface. Holdings are excluded.
      </p>

      <div className="overflow-x-auto">
        <table className="data-table">
          <thead>
            <tr>
              <th className="pl-3.5">Name</th>
              <th className="n" title="Places climbed in SIA's ranking this week">Climbed</th>
              <th className="n">Rank</th>
              <th className="n">SMAX</th>
              <th>Sector</th>
              <th className="pr-3.5 text-right">Known as</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ticker}>
                <td className="pl-3.5">
                  <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono font-medium text-ink hover:text-accent hover:underline">
                    {displayTicker(r.ticker)}
                  </Link>
                </td>
                <td className="n text-pos">+{r.wChg}</td>
                <td className="n text-ink-2">{r.rank}</td>
                <td className="n text-ink-2">{r.smax ?? "—"}</td>
                <td className="text-[12px] text-ink-2">{r.sector ?? ""}</td>
                <td className="pr-3.5 text-right text-[12px]">
                  {!r.onList && !r.onWatchlist && <span className="text-accent">on no list</span>}
                  {r.onList && <span className="text-ink-2">on a list</span>}
                  {r.onList && r.onWatchlist && <span className="text-ink-3"> · </span>}
                  {r.onWatchlist && <span className="text-ink-2">watchlist</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > shown.length && (
        <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
          {shown.length} of {rows.length}
          <button onClick={toggleShowAll} className="ml-auto text-accent hover:underline">Show all {rows.length}</button>
        </div>
      )}
      {showAll && rows.length > 12 && (
        <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
          {rows.length} of {rows.length}
          <button onClick={toggleShowAll} className="ml-auto text-accent hover:underline">Show fewer</button>
        </div>
      )}
    </section>
  );
}
