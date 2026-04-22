"use client";

/**
 * Score History tile — per-ticker append-only change log.
 *
 * Reads `pm:score-history` via /api/kv/score-history. Shows a
 * reverse-chronological table of past composite scores so the analyst
 * can see drift over time and which category changes drove it.
 *
 * First render (no history yet): shows the CURRENT live score and a
 * note that history begins at the next rescore. We deliberately do NOT
 * seed an entry from this component — writes happen only in `handleScore`
 * on the stock page, after a fresh score is computed.
 *
 * Informational only — not wired into risk alerts or composite score.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Scores, ScoreKey } from "@/app/lib/types";
import { SCORE_GROUPS } from "@/app/lib/types";

type Entry = {
  date: string;
  timestamp: string;
  total: number;
  raw: number;
  adjusted: number;
  scores: Scores;
};

type Props = {
  ticker: string;
  currentTotal: number;
  currentRaw: number;
  className?: string;
};

// Flatten SCORE_GROUPS → [{key,label}] for delta rendering
const ALL_CATEGORIES: { key: ScoreKey; label: string }[] = SCORE_GROUPS.flatMap((g) =>
  g.categories.map((c) => ({ key: c.key as ScoreKey, label: c.label })),
);

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return iso;
  }
}

export default function ScoreHistory({ ticker, currentTotal, currentRaw, className = "" }: Props) {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/kv/score-history", { cache: "no-store" });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const all = (data?.history ?? {}) as Record<string, Entry[]>;
      const tk = ticker.toUpperCase();
      setEntries(Array.isArray(all[tk]) ? all[tk] : []);
    } catch {
      setError("Unable to load score history");
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    load();
  }, [load]);

  // Reverse-chronological list with deltas computed vs previous entry.
  const rows = useMemo(() => {
    if (!entries) return [];
    // entries are appended in chronological order; reverse for display
    const sorted = [...entries].reverse();
    return sorted.map((e, i) => {
      const prev = sorted[i + 1]; // older entry
      const totalDelta = prev ? e.total - prev.total : null;
      const categoryChanges: { key: ScoreKey; label: string; from: number; to: number }[] = [];
      if (prev) {
        for (const cat of ALL_CATEGORIES) {
          const from = prev.scores?.[cat.key] ?? 0;
          const to = e.scores?.[cat.key] ?? 0;
          if (from !== to) {
            categoryChanges.push({ key: cat.key, label: cat.label, from, to });
          }
        }
      }
      return { entry: e, totalDelta, categoryChanges };
    });
  }, [entries]);

  return (
    <div className={`rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-slate-700">Score History</h3>
          <p className="text-[11px] text-slate-400">Append-only log of composite score changes over time.</p>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-slate-400 uppercase tracking-wide">Current</div>
          <div className="text-lg font-bold text-slate-800">{currentTotal.toFixed(1)}</div>
          <div className="text-[10px] text-slate-400">Raw {currentRaw.toFixed(1)}</div>
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-slate-400">Loading&hellip;</div>
      ) : error ? (
        <div className="text-xs text-slate-400">{error}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-xs text-slate-500">
          No prior scores logged. The next time you click <span className="font-semibold">Rescore</span>, the new score will be appended here and every change going forward will be tracked.
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {rows.map(({ entry, totalDelta, categoryChanges }, idx) => {
            const isLatest = idx === 0;
            const deltaColor =
              totalDelta == null
                ? "text-slate-400"
                : totalDelta > 0
                ? "text-emerald-600"
                : totalDelta < 0
                ? "text-red-600"
                : "text-slate-500";
            return (
              <div key={`${entry.timestamp}-${idx}`} className="py-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-700">{fmtDate(entry.timestamp || entry.date)}</span>
                    {isLatest && (
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">Latest</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-slate-800">{entry.total.toFixed(1)}</span>
                    {totalDelta != null && (
                      <span className={`text-xs font-mono ${deltaColor}`}>
                        {totalDelta > 0 ? "+" : ""}{totalDelta.toFixed(1)}
                      </span>
                    )}
                  </div>
                </div>
                {categoryChanges.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {categoryChanges.map((c) => {
                      const diff = c.to - c.from;
                      const cls =
                        diff > 0
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-red-50 text-red-700 border-red-200";
                      return (
                        <span key={c.key} className={`rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>
                          {c.label}: {c.from} → {c.to}
                        </span>
                      );
                    })}
                  </div>
                )}
                {categoryChanges.length === 0 && totalDelta != null && totalDelta !== 0 && (
                  <div className="mt-1 text-[10px] text-slate-400">Regime-adjusted change only (no category edits)</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
