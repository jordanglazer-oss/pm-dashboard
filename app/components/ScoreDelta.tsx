"use client";

/**
 * Compact "score change since last rescore" pill for the top of the
 * Stock page. Shown immediately under the score donut so the PM sees
 * the recent trend without scrolling down to the full ScoreHistory
 * table.
 *
 * Reads `pm:score-history` via the same `/api/kv/score-history` route
 * the full history table uses. Returns null when there's no prior
 * entry to compare against (first rescore ever, or history was wiped)
 * so the slot collapses cleanly rather than showing "—".
 *
 * Informational only — does NOT mutate score history, does NOT trigger
 * a rescore. The append-only write still happens in handleScore on
 * the stock page after a fresh score is computed.
 */

import React, { useEffect, useMemo, useState } from "react";

type Entry = {
  date: string;
  timestamp: string;
  total: number;
  raw: number;
  adjusted: number;
};

type Props = {
  ticker: string;
  className?: string;
};

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

export function ScoreDelta({ ticker, className = "" }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/kv/score-history", { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const all = (data?.history ?? {}) as Record<string, Entry[]>;
        const tk = ticker.toUpperCase();
        if (!cancelled) setEntries(Array.isArray(all[tk]) ? all[tk] : []);
      } catch {
        // Non-fatal — the full ScoreHistory table will surface its own error.
      }
    })();
    return () => { cancelled = true; };
  }, [ticker]);

  // Compute the delta between the two most recent entries. We deliberately
  // compare entry-to-entry (last rescore vs the one before) rather than
  // current-stock-state vs latest history entry, so the pill always
  // reflects a discrete user-triggered rescore event and isn't muddied
  // by mid-day regime adjustments.
  const summary = useMemo(() => {
    if (!entries || entries.length < 2) return null;
    const latest = entries[entries.length - 1];
    const prior = entries[entries.length - 2];
    const delta = latest.total - prior.total;
    return { latest, prior, delta };
  }, [entries]);

  if (!summary) return null;
  const { latest, prior, delta } = summary;
  const absDelta = Math.abs(delta);
  const positive = delta > 0;
  const neutral = absDelta < 0.05;

  const palette = neutral
    ? "bg-slate-50 border-slate-200 text-slate-600"
    : positive
    ? "bg-emerald-50 border-emerald-200 text-emerald-700"
    : "bg-red-50 border-red-200 text-red-700";

  const sign = positive ? "+" : "";

  return (
    <div
      className={`mt-2 flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] ${palette} ${className}`}
      title={`Last rescore on ${fmtDate(latest.timestamp)} changed the composite from ${prior.total.toFixed(1)} to ${latest.total.toFixed(1)} (prior rescore: ${fmtDate(prior.timestamp)}). Manual category edits within 72h of a rescore roll into the same entry, so the number reflects your final reviewed composite — not the AI-only value.`}
    >
      <span className="font-semibold">
        {neutral ? "Unchanged" : `${sign}${delta.toFixed(1)} pt${absDelta === 1 ? "" : "s"}`}
      </span>
      <span className="opacity-60">•</span>
      <span className="opacity-80">
        {prior.total.toFixed(1)} → {latest.total.toFixed(1)} since {fmtDate(prior.timestamp)}
      </span>
    </div>
  );
}
