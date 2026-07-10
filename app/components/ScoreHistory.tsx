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
  /** Set when the rescore used Anthropic web_search to verify cached
   *  fundamentals against the latest filings / press releases. */
  verifiedSearch?: boolean;
  /** Each query the model issued during the verified rescore. */
  searchQueries?: string[];
  /** URLs the model cited as sources. */
  searchCitations?: Array<{ url: string; title?: string }>;
  /** ISO timestamp of the most recent manual-edit overwrite of this
   *  entry's total/scores. Present when a category was tweaked within
   *  the 72h revision window. */
  revisedAt?: string;
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
  // Which entries have their Sources panel expanded. Keyed by the
  // entry's timestamp since that's unique per rescore (history is
  // strictly chronological). Collapsed by default to keep the panel
  // compact; the PM expands when they want to audit Claude's sourcing.
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());

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
    <div className={`rounded-card border border-line bg-white p-5 shadow-sm ${className}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="text-sm font-bold text-ink-2">Score History</h3>
          <p className="text-[11px] text-ink-3">Append-only log of composite score changes over time.</p>
        </div>
        <div className="text-right">
          <div className="text-[11px] text-ink-3 uppercase tracking-wide">Current</div>
          <div className="text-lg font-bold text-ink">{currentTotal.toFixed(1)}</div>
          <div className="text-[10px] text-ink-3">Raw {currentRaw.toFixed(1)}</div>
        </div>
      </div>

      {loading ? (
        <div className="text-xs text-ink-3">Loading&hellip;</div>
      ) : error ? (
        <div className="text-xs text-ink-3">{error}</div>
      ) : rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line bg-surface-2 p-3 text-xs text-ink-3">
          No prior scores logged. The next time you click <span className="font-semibold">Rescore</span>, the new score will be appended here and every change going forward will be tracked.
        </div>
      ) : (
        <div className="divide-y divide-line-soft">
          {rows.map(({ entry, totalDelta, categoryChanges }, idx) => {
            const isLatest = idx === 0;
            const deltaColor =
              totalDelta == null
                ? "text-ink-3"
                : totalDelta > 0
                ? "text-pos"
                : totalDelta < 0
                ? "text-neg"
                : "text-ink-3";
            return (
              <div key={`${entry.timestamp}-${idx}`} className="py-2.5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-ink-2">{fmtDate(entry.timestamp || entry.date)}</span>
                    {isLatest && (
                      <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-3">Latest</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold text-ink">{entry.total.toFixed(1)}</span>
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
                          ? "bg-pos-soft text-pos border-pos-border"
                          : "bg-neg-soft text-neg border-neg-border";
                      return (
                        <span key={c.key} className={`rounded-full border px-2 py-0.5 text-[10px] ${cls}`}>
                          {c.label}: {c.from} → {c.to}
                        </span>
                      );
                    })}
                  </div>
                )}
                {categoryChanges.length === 0 && totalDelta != null && totalDelta !== 0 && (
                  <div className="mt-1 text-[10px] text-ink-3">Regime-adjusted change only (no category edits)</div>
                )}
                {/* Sources audit: web_search queries + citation URLs.
                    Collapsed by default to keep the panel compact;
                    PM clicks to expand when they want to verify Claude's
                    sourcing on a specific rescore. */}
                {(() => {
                  const queries = entry.searchQueries ?? [];
                  const citations = entry.searchCitations ?? [];
                  if (queries.length === 0 && citations.length === 0) return null;
                  const expanded = expandedSources.has(entry.timestamp);
                  return (
                    <div className="mt-1.5">
                      <button
                        onClick={() => {
                          setExpandedSources((prev) => {
                            const next = new Set(prev);
                            if (next.has(entry.timestamp)) next.delete(entry.timestamp);
                            else next.add(entry.timestamp);
                            return next;
                          });
                        }}
                        className="inline-flex items-center gap-1 text-[10px] text-ink-3 hover:text-ink-2 transition-colors"
                      >
                        <svg className={`w-2.5 h-2.5 transition-transform ${expanded ? "rotate-90" : ""}`} fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="m8.25 4.5 7.5 7.5-7.5 7.5" /></svg>
                        Sources · {queries.length} {queries.length === 1 ? "search" : "searches"}
                        {citations.length > 0 && ` · ${citations.length} ${citations.length === 1 ? "citation" : "citations"}`}
                      </button>
                      {expanded && (
                        <div className="mt-1.5 rounded-lg bg-surface-2 border border-line p-2.5 space-y-2">
                          {queries.length > 0 && (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-3 mb-1">Search queries Claude issued</div>
                              <ul className="space-y-0.5">
                                {queries.map((q, i) => (
                                  <li key={i} className="text-[11px] text-ink-2 break-words">
                                    <span className="text-ink-3">{i + 1}.</span> {q}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {citations.length > 0 && (
                            <div>
                              <div className="text-[10px] uppercase tracking-wider font-semibold text-ink-3 mb-1">Citation URLs</div>
                              <ul className="space-y-0.5">
                                {citations.map((c, i) => (
                                  <li key={i} className="text-[11px] break-all">
                                    <a
                                      href={c.url}
                                      target="_blank"
                                      rel="noreferrer noopener"
                                      className="text-accent hover:underline"
                                      title={c.title ?? c.url}
                                    >
                                      {c.title ? `${c.title} ↗` : `${c.url} ↗`}
                                    </a>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
