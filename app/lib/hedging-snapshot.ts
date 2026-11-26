/** Pure rules for filing SPY hedging prices in pm:hedging-history (no I/O). */

import { easternToday } from "./date-eastern";

/**
 * The date a set of prices is filed under in pm:hedging-history: the Eastern
 * day the QUOTES are from (a delayed or closed-market feed returns an earlier
 * session), else today (UTC, as before the quotes carried a time).
 */
export function snapshotDateFor(live: { quotesAsOfDate?: string }): string {
  return live.quotesAsOfDate ?? new Date().toISOString().slice(0, 10);
}

/**
 * Add a snapshot to the ledger. Today's entry (UTC or Eastern) can be replaced
 * by a newer reading; an entry for an EARLIER day is history — it is only
 * added when that day is missing, never replaced.
 */
export function mergeHedgingSnapshot<T extends { date: string }>(snapshots: T[], snapshot: T, now: Date = new Date()): { snapshots: T[]; wrote: boolean } {
  const idx = snapshots.findIndex((s) => s.date === snapshot.date);
  const isToday = snapshot.date === now.toISOString().slice(0, 10) || snapshot.date === easternToday(now);
  if (idx >= 0 && !isToday) return { snapshots, wrote: false };
  const next = [...snapshots];
  if (idx >= 0) next[idx] = snapshot;
  else {
    next.push(snapshot);
    next.sort((a, b) => a.date.localeCompare(b.date));
  }
  return { snapshots: next, wrote: true };
}
