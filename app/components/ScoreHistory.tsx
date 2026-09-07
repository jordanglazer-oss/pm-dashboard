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
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { AppIcon } from "@/app/components/AppIcon";

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
  // Transient by design: one-at-a-time audit detail, not a layout fold.
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
    <CollapsibleSection
      prefKey="stock.scoreHistory"
      defaultCollapsed
      className={`border-line ${className}`}
      title="Score history"
      subtitle="append-only log of composite changes"
      right={
        <span className="text-[11.5px] text-ink-3">
          current <span className="font-mono font-medium text-ink">{currentTotal.toFixed(1)}</span> · raw <span className="font-mono">{currentRaw.toFixed(1)}</span>
        </span>
      }
    >
      {loading ? (
        <div className="text-[11.5px] text-ink-3">Loading…</div>
      ) : error ? (
        <div className="text-[11.5px] text-ink-3">{error}</div>
      ) : rows.length === 0 ? (
        <div className="text-[12.5px] leading-[1.5] text-ink-2">
          No prior scores logged. The next time you click <span className="font-medium text-ink">Rescore</span>, the new score will be appended here and every change going forward will be tracked.
        </div>
      ) : (
        <div className="-mx-3.5 -my-3">
          <table className="data-table">
            <thead>
              <tr>
                <th className="pl-3.5">Date</th>
                <th className="n">Score</th>
                <th className="n">Change</th>
                <th>Category changes</th>
              </tr>
            </thead>
            <tbody>
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
                const queries = entry.searchQueries ?? [];
                const citations = entry.searchCitations ?? [];
                const hasSources = queries.length > 0 || citations.length > 0;
                const expanded = expandedSources.has(entry.timestamp);
                return (
                  <React.Fragment key={`${entry.timestamp}-${idx}`}>
                    <tr>
                      <td className="pl-3.5 align-top">
                        <span className="font-mono">{fmtDate(entry.timestamp || entry.date)}</span>
                        {isLatest && <span className="ml-1.5 text-[11px] text-ink-3">latest</span>}
                      </td>
                      <td className="n align-top font-medium">{entry.total.toFixed(1)}</td>
                      <td className={`n align-top ${deltaColor}`}>
                        {totalDelta != null ? `${totalDelta > 0 ? "+" : ""}${totalDelta.toFixed(1)}` : "—"}
                      </td>
                      <td className="whitespace-normal py-2 align-top text-[12px] leading-[1.5]">
                        {categoryChanges.length > 0 ? (
                          <span className="text-ink-2">
                            {categoryChanges.map((c, i) => {
                              const diff = c.to - c.from;
                              return (
                                <span key={c.key}>
                                  {i > 0 && <span className="text-ink-faint"> · </span>}
                                  {c.label} <span className={`font-mono ${diff > 0 ? "text-pos" : "text-neg"}`}>{c.from} → {c.to}</span>
                                </span>
                              );
                            })}
                          </span>
                        ) : totalDelta != null && totalDelta !== 0 ? (
                          <span className="text-ink-3">Regime-adjusted change only (no category edits)</span>
                        ) : (
                          <span className="text-ink-faint">—</span>
                        )}
                        {/* Sources audit: web_search queries + citation URLs.
                            Collapsed by default to keep the panel compact;
                            PM clicks to expand when they want to verify Claude's
                            sourcing on a specific rescore. */}
                        {hasSources && (
                          <button
                            onClick={() => {
                              setExpandedSources((prev) => {
                                const next = new Set(prev);
                                if (next.has(entry.timestamp)) next.delete(entry.timestamp);
                                else next.add(entry.timestamp);
                                return next;
                              });
                            }}
                            className="ml-2 inline-flex items-center gap-1 text-[11px] text-ink-3 transition-colors hover:text-ink"
                          >
                            <AppIcon name={expanded ? "chevD" : "chevR"} size={11} />
                            Sources · {queries.length} {queries.length === 1 ? "search" : "searches"}
                            {citations.length > 0 && ` · ${citations.length} ${citations.length === 1 ? "citation" : "citations"}`}
                          </button>
                        )}
                      </td>
                    </tr>
                    {hasSources && expanded && (
                      <tr>
                        <td colSpan={4} className="whitespace-normal bg-surface-2 py-2.5 pl-3.5 align-top">
                          <div className="flex flex-col gap-2 text-[11.5px]">
                            {queries.length > 0 && (
                              <div>
                                <div className="mb-1 text-[11px] text-ink-3">Search queries Claude issued</div>
                                <ol className="flex list-decimal flex-col gap-0.5 pl-4 text-ink-2">
                                  {queries.map((q, i) => (
                                    <li key={i} className="break-words">{q}</li>
                                  ))}
                                </ol>
                              </div>
                            )}
                            {citations.length > 0 && (
                              <div>
                                <div className="mb-1 text-[11px] text-ink-3">Citation URLs</div>
                                <ul className="flex flex-col gap-0.5">
                                  {citations.map((c, i) => (
                                    <li key={i} className="break-all">
                                      <a
                                        href={c.url}
                                        target="_blank"
                                        rel="noreferrer noopener"
                                        className="inline-flex items-center gap-1 text-accent hover:underline"
                                        title={c.title ?? c.url}
                                      >
                                        {c.title ?? c.url} <AppIcon name="external" size={11} />
                                      </a>
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </CollapsibleSection>
  );
}
