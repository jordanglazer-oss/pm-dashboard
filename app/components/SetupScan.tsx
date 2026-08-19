"use client";

import React, { useCallback, useEffect, useState } from "react";
import { displayTicker } from "@/app/lib/ticker";

/**
 * Setups — names that look ready to move, rather than names that already have.
 *
 * Kept apart from the Suggested Watchlist on purpose. Everything there is a
 * research provider's assertion, and every provider publishes AFTER a move, so
 * that list structurally cannot contain a stock still coiling. This is the one
 * reading the dashboard computes itself, and mixing the two would blur which
 * is which.
 *
 * Two scores, never averaged:
 *   Base (0-4)      a strong stock going quiet — near its high, range
 *                   tightening, volume drying up, holding above both MAs.
 *   Improving (0-6) a weak stock turning — RSI off a low, MACD up, nearing a
 *                   DMA from below, reclaiming the cloud.
 * They describe opposite situations and call for different trades; one blended
 * number would hide which one a name actually is.
 */

type Row = {
  ticker: string;
  name?: string;
  sector?: string;
  price: number;
  improving: { score: number; label: string; active: string[] };
  base: null | {
    pctFromHigh: number;
    contraction: number;
    volumeDryUp: number;
    aboveBothMAs: boolean;
    score: number;
    label: string;
    detail: string;
  };
  error?: string;
};

type Scan = {
  generatedAt: string | null;
  universe?: string;
  scanned?: number;
  requested?: number;
  reused?: number;
  failed?: number;
  remaining?: number;
  note?: string;
  rows: Row[];
};

const BASE_TONE: Record<string, string> = {
  Coiled: "bg-pos-soft text-pos ring-pos-border",
  Building: "bg-accent-soft text-accent ring-accent-border",
  Loose: "bg-surface-2 text-ink-3 ring-line",
  None: "bg-surface-2 text-ink-faint ring-line",
};

export function SetupScan({ onCountChange }: { onCountChange?: (n: number) => void }) {
  const [scan, setScan] = useState<Scan>({ generatedAt: null, rows: [] });
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [universe, setUniverse] = useState<"suggested" | "watchlist" | "portfolio">("suggested");
  const [sortBy, setSortBy] = useState<"base" | "improving">("base");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/setup-scan", { cache: "no-store" });
      if (r.ok) {
        const d: Scan = await r.json();
        setScan(d);
        onCountChange?.(d.rows.filter((x) => (x.base?.score ?? 0) >= 3).length);
      }
    } finally {
      setLoading(false);
    }
  }, [onCountChange]);
  useEffect(() => { load(); }, [load]);

  const run = async () => {
    setRunning(true);
    try {
      // An empty body scans the suggested candidates; the other two universes
      // are resolved server-side from pm:stocks by bucket.
      const body = universe === "suggested" ? {} : { universe };
      const r = await fetch("/api/setup-scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (r.ok) {
        const d: Scan = await r.json();
        setScan(d);
        onCountChange?.(d.rows.filter((x) => (x.base?.score ?? 0) >= 3).length);
      }
    } finally {
      setRunning(false);
    }
  };

  const rows = [...scan.rows].sort((a, b) =>
    sortBy === "base"
      ? (b.base?.score ?? -1) - (a.base?.score ?? -1) || b.improving.score - a.improving.score
      : b.improving.score - a.improving.score || (b.base?.score ?? -1) - (a.base?.score ?? -1),
  );

  const th = "pb-2 pr-3 text-left text-[11px] font-semibold uppercase tracking-wide text-ink-3";

  return (
    <div className="rounded-card border border-line bg-white p-5 shadow-card">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold text-ink">Setups</h2>
          <p className="text-xs text-ink-3">
            Names that look ready to move — computed from price, not taken from a research list.
            {scan.generatedAt && ` · ${scan.scanned ?? scan.rows.length} scanned ${new Date(scan.generatedAt).toLocaleString()}`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            value={universe}
            onChange={(e) => setUniverse(e.target.value as typeof universe)}
            className="rounded-control border border-line bg-surface-2 px-2 py-1.5 text-ink"
          >
            <option value="suggested">Suggested candidates</option>
            <option value="watchlist">Watchlist</option>
            <option value="portfolio">Portfolio</option>
          </select>
          <button
            onClick={() => setSortBy((s) => (s === "base" ? "improving" : "base"))}
            className="rounded-control border border-line px-3 py-1.5 font-semibold text-ink-2 hover:text-ink"
          >
            Sort: {sortBy === "base" ? "Coiling" : "Recovering"}
          </button>
          <button
            onClick={run}
            disabled={running}
            className="rounded-control bg-accent px-3 py-1.5 font-semibold !text-white disabled:opacity-50"
          >
            {running ? "Scanning…" : "Run scan"}
          </button>
        </div>
      </div>

      {scan.note && (
        <div className="mb-3 rounded border border-warn-border bg-warn-soft px-3 py-2 text-xs text-warn">
          {scan.note}
          {typeof scan.failed === "number" && scan.failed > 0 && ` ${scan.failed} failed this pass.`}
          {typeof scan.reused === "number" && scan.reused > 0 && ` ${scan.reused} reused from earlier today.`}
        </div>
      )}

      {loading ? (
        <p className="py-8 text-center text-xs text-ink-3">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-xs text-ink-3">
          No scan yet — pick a universe and hit Run scan.
        </p>
      ) : (
        <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-line">
                <th className={th}>Ticker</th>
                <th className={th}>Name</th>
                <th className={th}>Sector</th>
                <th className={`${th} text-right`}>Price</th>
                <th className={`${th} text-right`}>Off high</th>
                <th className={th}>Base</th>
                <th className={th}>Recovering</th>
                <th className={th}>Why</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.ticker} className="border-b border-line-soft hover:bg-surface-hover">
                  <td className="py-2.5 pr-3 font-mono text-xs font-semibold text-ink">{displayTicker(r.ticker)}</td>
                  <td className="max-w-[200px] truncate py-2.5 pr-3 text-ink">{r.name || "—"}</td>
                  <td className="py-2.5 pr-3 text-xs text-ink-2">{r.sector || "—"}</td>
                  <td className="py-2.5 pr-3 text-right font-mono text-xs tabular-nums text-ink-2">
                    {r.price > 0 ? r.price.toFixed(2) : "—"}
                  </td>
                  <td className="py-2.5 pr-3 text-right font-mono text-xs tabular-nums text-ink-2">
                    {r.base ? `${r.base.pctFromHigh.toFixed(1)}%` : "—"}
                  </td>
                  <td className="py-2.5 pr-3">
                    {r.base ? (
                      <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ring-1 ${BASE_TONE[r.base.label] ?? BASE_TONE.None}`}>
                        {r.base.label} {r.base.score}/4
                      </span>
                    ) : (
                      <span className="text-[11px] text-ink-faint">{r.error || "—"}</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-3">
                    <span className="text-[11px] text-ink-2">
                      {r.improving.label} {r.improving.score}/6
                    </span>
                  </td>
                  <td className="py-2.5 pr-3 text-[11px] text-ink-3">
                    {r.base?.detail || r.improving.active.join(" · ") || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
