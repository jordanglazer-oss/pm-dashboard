"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { displayTicker } from "@/app/lib/ticker";
import { Skeleton } from "@/app/components/Skeleton";
import { EmptyState } from "@/app/components/EmptyState";

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

const ACTION_TONE: Record<string, string> = {
  add: "bg-pos-soft text-pos border-pos-border",
  buy: "bg-pos-soft text-pos border-pos-border",
  trim: "bg-warn-soft text-warn border-warn-border",
  sell: "bg-neg-soft text-neg border-neg-border",
  exit: "bg-neg-soft text-neg border-neg-border",
};

function Rel({ v, partial }: { v: number | null; partial: boolean }) {
  if (v == null) return <span className="text-ink-faint">—</span>;
  return (
    <span className={`font-mono ${v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2"}`}>
      {v > 0 ? "+" : ""}
      {v.toFixed(1)}%{partial && <span className="ml-1 text-[10px] text-ink-3">so far</span>}
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
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-ink md:px-8 md:py-8">
      <div className="mx-auto max-w-7xl">
        <div className="mb-5 flex flex-wrap items-center gap-3">
          <div>
            <h1 className="text-[17px] font-semibold tracking-[-0.02em]">Decision Journal — Attribution</h1>
            <p className="text-xs text-ink-3">
              every logged decision vs its sector · hit rates count completed windows only
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            {data && (
              <span className="font-mono text-[11px] text-ink-faint">
                computed {new Date(data.computedAt).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
              </span>
            )}
            <button
              onClick={() => load(true)}
              disabled={refreshing}
              className="rounded-control border border-line bg-white px-2.5 py-1 text-xs font-semibold text-ink-2 hover:text-ink disabled:opacity-50"
            >
              {refreshing ? "Recomputing…" : "↻ Refresh"}
            </button>
          </div>
        </div>

        {loading && <Skeleton className="h-40 w-full" />}

        {!loading && (!data || data.rows.length + data.skipped.length === 0) && (
          <EmptyState
            glyph="📓"
            title="No decisions logged yet"
            body="Log decisions from the Portfolio page's Decision Journal, or respond to a kill-condition trip on a stock page — every entry lands here with its forward return."
          />
        )}

        {data && data.rows.length + data.skipped.length > 0 && (
          <>
            {/* ── Hit-rate stats ── */}
            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="rounded-card border border-line bg-white p-4 shadow-sm">
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">
                  Buys / adds — right vs sector
                </div>
                <div className="mt-1 text-2xl font-semibold tracking-tight">
                  {pctStr(data.stats.buys.hits, data.stats.buys.n)}
                  <span className="ml-2 text-sm font-normal text-ink-3">
                    {data.stats.buys.n > 0 ? `${data.stats.buys.hits} of ${data.stats.buys.n}` : "no completed windows yet"}
                  </span>
                </div>
                {data.stats.buys.avgRel3m != null && (
                  <div className="mt-0.5 text-xs text-ink-3">
                    avg 3M sector-relative {data.stats.buys.avgRel3m > 0 ? "+" : ""}
                    {data.stats.buys.avgRel3m}%
                  </div>
                )}
                {data.stats.buys.n > 0 && data.stats.buys.n < 10 && (
                  <div className="mt-1 text-[11px] text-warn">small sample — read direction, not precision</div>
                )}
              </div>
              <div className="rounded-card border border-line bg-white p-4 shadow-sm">
                <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">
                  Trims / sells — right to reduce
                </div>
                <div className="mt-1 text-2xl font-semibold tracking-tight">
                  {pctStr(data.stats.trims.hits, data.stats.trims.n)}
                  <span className="ml-2 text-sm font-normal text-ink-3">
                    {data.stats.trims.n > 0 ? `${data.stats.trims.hits} of ${data.stats.trims.n}` : "no completed windows yet"}
                  </span>
                </div>
                {data.stats.trims.avgRel3m != null && (
                  <div className="mt-0.5 text-xs text-ink-3">
                    names averaged {data.stats.trims.avgRel3m > 0 ? "+" : ""}
                    {data.stats.trims.avgRel3m}% vs sector after the trim
                    {data.stats.trims.avgRel3m > 0 ? " — trimmed winners early" : ""}
                  </div>
                )}
                {data.stats.trims.n > 0 && data.stats.trims.n < 10 && (
                  <div className="mt-1 text-[11px] text-warn">small sample — read direction, not precision</div>
                )}
              </div>
            </div>

            {/* ── Decision log ── */}
            <div className="overflow-x-auto rounded-card border border-line bg-white shadow-sm">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-line text-left">
                    <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">Date</th>
                    <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">Name</th>
                    <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">Decision</th>
                    <th className="px-3 py-2 text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">Rationale at the time</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">1M rel</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">3M rel</th>
                    <th className="px-3 py-2 text-right text-[10px] font-bold uppercase tracking-[0.08em] text-ink-3">Call</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {data.rows.map((r) => (
                    <tr key={r.id} className="align-top">
                      <td className="whitespace-nowrap px-3 py-2 font-mono text-[11px] text-ink-3">{r.date}</td>
                      <td className="px-3 py-2">
                        <Link href={`/stock/${encodeURIComponent(r.ticker)}`} className="font-mono font-bold text-ink hover:text-accent">
                          {displayTicker(r.ticker)}
                        </Link>
                        <div className="text-[10px] text-ink-faint">vs {r.benchmark}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase ${ACTION_TONE[r.action.toLowerCase()] || "border-line bg-surface-2 text-ink-2"}`}>
                          {r.action}
                        </span>
                      </td>
                      <td className="max-w-[420px] px-3 py-2 text-ink-2">
                        <span className="line-clamp-2" title={r.rationale}>
                          {r.rationale}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Rel v={r.rel1m} partial={r.partial1m} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Rel v={r.rel3m} partial={r.partial3m} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {r.hit == null ? (
                          <span className="text-[11px] text-ink-faint">{r.partial3m || r.partial1m ? "pending" : "n/a"}</span>
                        ) : r.hit ? (
                          <span className="text-[11px] font-bold text-pos">RIGHT</span>
                        ) : (
                          <span className="text-[11px] font-bold text-neg">WRONG</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {data.skipped.length > 0 && (
              <p className="mt-3 text-[11px] text-ink-3">
                Not measured ({data.skipped.length}):{" "}
                {data.skipped.map((s) => `${s.ticker ?? "—"} (${s.reason})`).join(" · ")}
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
