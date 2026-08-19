"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
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
    volumeCharacter?: "dry-up" | "accumulation" | "distribution" | "neutral";
    upVolumeShare?: number;
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
  fetched?: number;
  failed?: number;
  remaining?: number;
  complete?: number;
  note?: string;
  rows: Row[];
};

/** Enough passes to cover a few hundred names; the loop exits early once the
 *  universe is covered or the limiter stops answering. */
const MAX_PASSES = 12;
const PAUSE_MS = 2500;

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
  const [passInfo, setPassInfo] = useState<{ pass: number; remaining: number } | null>(null);
  const stopRef = useRef(false);

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

  /**
   * Run slices until the universe is covered, rather than making the PM press
   * the button five times.
   *
   * Each pass is a separate request on purpose: the slice size exists because
   * Yahoo throttles Vercel's shared IPs, so one long request would be refused
   * partway regardless. Pausing between passes gives the limiter room to
   * recover, which is what makes the next slice succeed.
   *
   * Stops on its own when nothing is left, when a pass reads NOTHING (fully
   * throttled — hammering will not help), or when the PM presses Stop.
   */
  const run = async () => {
    setRunning(true);
    stopRef.current = false;
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (stopRef.current) break;
        const body: Record<string, unknown> = universe === "suggested" ? {} : { universe };
        const r = await fetch("/api/setup-scan", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!r.ok) break;
        const d: Scan = await r.json();
        setScan(d);
        onCountChange?.(d.rows.filter((x) => (x.base?.score ?? 0) >= 3).length);
        setPassInfo({ pass: pass + 1, remaining: d.remaining ?? 0 });
        if ((d.remaining ?? 0) <= 0) break;
        if ((d.fetched ?? 0) === 0) break; // throttled flat — stop rather than spin
        await new Promise((res) => setTimeout(res, PAUSE_MS));
      }
    } finally {
      setRunning(false);
      setPassInfo(null);
      stopRef.current = false;
    }
  };

  const [showUnread, setShowUnread] = useState(false);
  const visible = showUnread ? scan.rows : scan.rows.filter((r) => !r.error);
  const rows = [...visible].sort((a, b) =>
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
            {scan.generatedAt && (
              <>
                {" · "}
                <span className="font-medium text-ink-2">
                  {scan.complete ?? scan.rows.filter((r) => !r.error).length} of {scan.requested ?? scan.rows.length} read
                </span>
                {` · ${new Date(scan.generatedAt).toLocaleString()}`}
              </>
            )}
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
            onClick={() => setShowUnread((v) => !v)}
            className="rounded-control border border-line px-3 py-1.5 font-semibold text-ink-2 hover:text-ink"
          >
            {showUnread ? "Hide unread" : `Show unread (${scan.rows.filter((r) => !!r.error).length})`}
          </button>
          <button
            onClick={() => setSortBy((s) => (s === "base" ? "improving" : "base"))}
            className="rounded-control border border-line px-3 py-1.5 font-semibold text-ink-2 hover:text-ink"
          >
            Sort: {sortBy === "base" ? "Coiling" : "Recovering"}
          </button>
          {running ? (
            <button
              onClick={() => { stopRef.current = true; }}
              className="rounded-control border border-neg-border bg-neg-soft px-3 py-1.5 font-semibold text-neg"
            >
              Stop
            </button>
          ) : (
            <button
              onClick={run}
              className="rounded-control bg-accent px-3 py-1.5 font-semibold !text-white"
            >
              {(scan.remaining ?? 0) > 0 ? `Continue (${scan.remaining} left)` : "Run scan"}
            </button>
          )}
        </div>
      </div>

      {running && (
        <div className="mb-3 rounded border border-accent-border bg-accent-soft px-3 py-2 text-xs text-accent">
          Scanning in passes{passInfo ? ` — pass ${passInfo.pass}, ${passInfo.remaining} left` : "…"}. Yahoo
          limits how much can be read at once, so this pauses between passes. Safe to leave running.
        </div>
      )}

      {!running && scan.note && (
        <div className="mb-3 rounded border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          {scan.note}
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
                  <td className="py-2.5 pr-3 text-[11px]">
                    <span className={r.base?.volumeCharacter === "distribution" ? "text-neg" : "text-ink-3"}>
                      {r.base?.detail || r.improving.active.join(" · ") || "—"}
                    </span>
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
