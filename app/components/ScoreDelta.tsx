"use client";

/**
 * Compact "score change since last rescore" read-out for the Score panel
 * header on the Stock page. Shown beside the donut so the PM sees the
 * recent trend without scrolling down to the full ScoreHistory table.
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
  rubricRev?: number;
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
  // current-stock-state vs latest history entry, so the read always
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
  const tone = neutral ? "text-ink-2" : positive ? "text-pos" : "text-neg";
  const sign = positive ? "+" : "";

  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink-3 ${className}`}
      title={`Last rescore on ${fmtDate(latest.timestamp)} changed the composite from ${prior.total.toFixed(1)} to ${latest.total.toFixed(1)} (prior rescore: ${fmtDate(prior.timestamp)}). Manual category edits within 72h of a rescore roll into the same entry, so the number reflects your final reviewed composite — not the AI-only value.`}
    >
      <span className={`font-mono font-medium ${tone}`}>
        {neutral ? "Unchanged" : `${sign}${delta.toFixed(1)}`}
      </span>
      <span>
        since {fmtDate(prior.timestamp)}
      </span>
      {typeof latest.rubricRev === "number" && (
        <span>· rubric rev <span className="font-mono">{latest.rubricRev}</span></span>
      )}
    </span>
  );
}
