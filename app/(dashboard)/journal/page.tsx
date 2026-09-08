"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { Skeleton } from "@/app/components/Skeleton";
import { EmptyState } from "@/app/components/EmptyState";
import { StatStrip } from "@/app/components/StatStrip";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * /journal — decision attribution (phase ③ of the thesis-discipline build,
 * preview-only). Renders /api/journal-attribution: every logged decision with
 * its forward sector-relative return, plus buy/trim hit rates.
 *
 * Read-only. Entries are logged elsewhere (the portfolio page's Decision
 * Journal, or the stock-page Thesis tile's trip buttons); this page only
 * measures them. Partial windows show as "so far" and are excluded from hit
 * rates — the numbers here never blend elapsed and unelapsed windows.
 */

type Row = {
  id: string;
  date: string;
  ticker: string;
  action: string;
  rationale: string;
  confidence?: string;
  sector?: string;
  benchmark: string;
  rel1m: number | null;
  rel3m: number | null;
  partial1m: boolean;
  partial3m: boolean;
  hit: boolean | null;
};
type Attribution = {
  computedAt: string;
  rows: Row[];
  skipped: { id: string; ticker?: string; reason: string }[];
  stats: {
    buys: { n: number; hits: number; avgRel3m: number | null };
    trims: { n: number; hits: number; avgRel3m: number | null };
  };
};

/** Decision word colour — sign carries the meaning (add/buy pos, trim warn,
 *  sell/exit neg); no pill, per the vocabulary. */
const ACTION_TONE: Record<string, string> = {
  add: "text-pos",
  buy: "text-pos",
  trim: "text-warn",
  sell: "text-neg",
  exit: "text-neg",
};

function Rel({ v, partial }: { v: number | null; partial: boolean }) {
  if (v == null) return <span className="text-ink-faint">—</span>;
  return (
    <span className={v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2"}>
      {v > 0 ? "+" : ""}
      {v.toFixed(1)}%{partial && <span className="ml-1 font-sans text-[11px] text-ink-3">so far</span>}
    </span>
  );
}

export default function JournalPage() {
  const [data, setData] = useState<Attribution | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (force: boolean) => {
    if (force) setRefreshing(true);
    try {
      const r = await fetch(`/api/journal-attribution${force ? "?refresh=1" : ""}`);
      const d = await r.json();
      if (d?.ok && d.data) setData(d.data as Attribution);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load(false);
  }, [load]);

  const pctStr = (hits: number, n: number) => (n > 0 ? `${Math.round((hits / n) * 100)}%` : "—");

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* Toolbar: meta on the left, recompute on the right. */}
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[12px] text-ink-3">
          Every logged decision vs its sector · hit rates count completed windows only ·{" "}
          <Link href="/methodology" className="text-accent hover:underline">how this works</Link>
        </span>
        <div className="ml-auto flex items-center gap-2">
          {data && (
            <span className="font-mono text-[11.5px] text-ink-3">
              computed {new Date(data.computedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
          )}
          <button
            onClick={() => load(true)}
            disabled={refreshing}
            className="inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover disabled:opacity-50"
          >
            <AppIcon name="refresh" size={13} className={refreshing ? "animate-spin" : ""} />
            {refreshing ? "Recomputing…" : "Refresh"}
          </button>
        </div>
      </div>

      {loading && <Skeleton className="h-40 w-full" />}

      {!loading && (!data || data.rows.length + data.skipped.length === 0) && (
        <section className="panel">
          <EmptyState
            glyph={<AppIcon name="book" size={18} />}
            title="No decisions logged yet"
            body="Log decisions from the Portfolio page's Decision Journal, or respond to a kill-condition trip on a stock page — every entry lands here with its forward return."
          />
        </section>
      )}

      {data && data.rows.length + data.skipped.length > 0 && (
        <>
          {/* ── Hit-rate stats: one hairline strip ── */}
          <StatStrip
            cols={2}
            items={[
              {
                label: "Buys / adds — right vs sector",
                value: (
                  <>
                    {pctStr(data.stats.buys.hits, data.stats.buys.n)}
                    <span className="ml-2 font-sans text-[11.5px] font-normal text-ink-3">
                      {data.stats.buys.n > 0 ? `${data.stats.buys.hits} of ${data.stats.buys.n}` : "no completed windows yet"}
                      {data.stats.buys.avgRel3m != null && (
                        <> · avg 3M sector-relative {data.stats.buys.avgRel3m > 0 ? "+" : ""}{data.stats.buys.avgRel3m}%</>
                      )}
                      {data.stats.buys.n > 0 && data.stats.buys.n < 10 && (
                        <span className="text-warn"> · small sample — read direction, not precision</span>
                      )}
                    </span>
                  </>
                ),
              },
              {
                label: "Trims / sells — right to reduce",
                value: (
                  <>
                    {pctStr(data.stats.trims.hits, data.stats.trims.n)}
                    <span className="ml-2 font-sans text-[11.5px] font-normal text-ink-3">
                      {data.stats.trims.n > 0 ? `${data.stats.trims.hits} of ${data.stats.trims.n}` : "no completed windows yet"}
                      {data.stats.trims.avgRel3m != null && (
                        <>
                          {" · "}names averaged {data.stats.trims.avgRel3m > 0 ? "+" : ""}
                          {data.stats.trims.avgRel3m}% vs sector after the trim
                          {data.stats.trims.avgRel3m > 0 ? " — trimmed winners early" : ""}
                        </>
                      )}
                      {data.stats.trims.n > 0 && data.stats.trims.n < 10 && (
                        <span className="text-warn"> · small sample — read direction, not precision</span>
                      )}
                    </span>
                  </>
                ),
              },
            ]}
          />

          {/* ── Decision log ── */}
          <section className="panel">
            <div className="panel-h">
              <span className="t">Decision log</span>
              <span className="m">{data.rows.length} measured</span>
            </div>
            <div className="tbl-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-3.5">Date</th>
                    <th>Name</th>
                    <th>Decision</th>
                    <th>Rationale at the time</th>
                    <th className="n">1M rel</th>
                    <th className="n">3M rel</th>
                    <th className="n">Call</th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.id}>
                      <td className="pl-3.5 font-mono text-ink-3">{r.date}</td>
                      <td>
                        <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono font-medium text-ink hover:text-accent">
                          {displayTicker(r.ticker)}
                        </Link>
                        <span className="ml-2 text-[11.5px] text-ink-3">vs {r.benchmark}</span>
                      </td>
                      <td className={`font-medium ${ACTION_TONE[r.action.toLowerCase()] || "text-ink-2"}`}>
                        {r.action}
                      </td>
                      <td className="max-w-[420px] !whitespace-normal py-2 text-ink-2">
                        <span className="line-clamp-2" title={r.rationale}>
                          {r.rationale}
                        </span>
                      </td>
                      <td className="n"><Rel v={r.rel1m} partial={r.partial1m} /></td>
                      <td className="n"><Rel v={r.rel3m} partial={r.partial3m} /></td>
                      <td className="n">
                        {r.hit == null ? (
                          <span className="font-sans text-ink-faint">{r.partial3m || r.partial1m ? "pending" : "n/a"}</span>
                        ) : r.hit ? (
                          <span className="font-sans font-medium text-pos">Right</span>
                        ) : (
                          <span className="font-sans font-medium text-neg">Wrong</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.skipped.length > 0 && (
              <div className="flex min-h-[32px] items-center border-t border-line-soft px-3.5 py-1.5 text-[11.5px] text-ink-3">
                Not measured ({data.skipped.length}):{" "}
                {data.skipped.map((s) => `${s.ticker ?? "—"} (${s.reason})`).join(" · ")}
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
