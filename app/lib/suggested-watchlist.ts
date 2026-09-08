/**
 * Suggested Watchlist — stage 2 of the idea funnel.
 *
 * The Suggested list is DERIVED, not stored: it is every ranked-research name
 * on ≥ SUGGESTED_MIN_LISTS bullish lists (research-ranked.ts), computed live
 * from pm:research on every read. What IS stored is the small amount of state
 * the derivation can't carry:
 *
 *   pm:suggested-watchlist  — per-ticker first/last-seen dates, the list count
 *                             at the previous refresh (so "gained a list" is
 *                             visible), and when coverage was requested.
 *                             `initialBuildAt` marks the first-ever build:
 *                             names present THEN never auto-email the desk
 *                             (a 40-email flood on day one), names entering
 *                             AFTER it do.
 *   pm:synthesis-decisions  — the PM's verdict on a Suggested name after
 *                             reading its synthesis: advance / watch / pass,
 *                             each remembered for DECISION_MEMORY_DAYS so a
 *                             passed name doesn't resurface next week and a
 *                             watched one isn't nagged for a fresh synthesis.
 *
 * Both are small operational keys. Losing pm:suggested-watchlist costs the
 * first-seen dates and re-arms the initial-build guard (safe: no emails go
 * out on a first build). Losing pm:synthesis-decisions costs 30 days of pass
 * memory — passed names reappear, nothing user-authored is lost.
 *
 * Pure module: no Redis, no fetch. The route supplies stores and persists.
 */

import { SUGGESTED_MIN_LISTS, type RankedRow } from "./research-ranked";

export const SUGGESTED_STORE_KEY = "pm:suggested-watchlist";
export const DECISIONS_KEY = "pm:synthesis-decisions";
export const DECISION_MEMORY_DAYS = 30;

export type SuggestedDecision = "advance" | "watch" | "pass";

export type DecisionEntry = {
  verdict: SuggestedDecision;
  /** ISO timestamp the PM clicked. */
  decidedAt: string;
};

export type DecisionStore = Record<string, DecisionEntry>;

export type SuggestedEntry = {
  ticker: string;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Bullish list count at the most recent refresh. */
  listCount: number;
  /** List count at the refresh BEFORE that — the delta is the "gained a list" signal. */
  prevListCount?: number;
  /** Set when the coverage-request email was queued for this name. */
  coverageRequestedAt?: string;
};

export type SuggestedStore = {
  initialBuildAt?: string;
  updatedAt?: string;
  entries: Record<string, SuggestedEntry>;
};

export const emptySuggestedStore = (): SuggestedStore => ({ entries: {} });

/** Rows that qualify for the Suggested list. */
export function qualifyingRows(ranked: RankedRow[]): RankedRow[] {
  return ranked.filter((r) => r.listCount >= SUGGESTED_MIN_LISTS);
}

/** A decision still inside its memory window, else null. */
export function activeDecision(decisions: DecisionStore, ticker: string, nowMs = Date.now()): DecisionEntry | null {
  const d = decisions[ticker.toUpperCase()];
  if (!d?.decidedAt) return null;
  const age = nowMs - Date.parse(d.decidedAt);
  if (!Number.isFinite(age) || age > DECISION_MEMORY_DAYS * 86_400_000) return null;
  return d;
}

/** ISO date the decision's memory expires. */
export function decisionExpiresOn(d: DecisionEntry): string {
  return new Date(Date.parse(d.decidedAt) + DECISION_MEMORY_DAYS * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Fold the current qualifying rows into the store. Returns the next store and
 * the tickers that are NEW since the last refresh (candidates for the
 * coverage-request email — the route decides whether to send).
 *
 * Entries for names that no longer qualify are kept (they carry first-seen
 * history and the prevListCount baseline) but are not returned as rows —
 * the read path only ever shows what qualifies NOW.
 */
export function mergeSuggestedStore(
  prev: SuggestedStore,
  qualifying: RankedRow[],
  nowIso: string,
): { next: SuggestedStore; newTickers: string[]; isInitialBuild: boolean } {
  const isInitialBuild = !prev.initialBuildAt;
  const entries: Record<string, SuggestedEntry> = { ...(prev.entries ?? {}) };
  const newTickers: string[] = [];
  for (const r of qualifying) {
    const key = r.ticker.toUpperCase();
    const e = entries[key];
    if (e) {
      entries[key] = {
        ...e,
        lastSeenAt: nowIso,
        // Only roll the baseline when the count actually changed, so the
        // "gained a list" chip survives more than one refresh.
        prevListCount: e.listCount !== r.listCount ? e.listCount : e.prevListCount,
        listCount: r.listCount,
      };
    } else {
      entries[key] = { ticker: r.ticker, firstSeenAt: nowIso, lastSeenAt: nowIso, listCount: r.listCount };
      newTickers.push(r.ticker);
    }
  }
  return {
    next: { initialBuildAt: prev.initialBuildAt ?? nowIso, updatedAt: nowIso, entries },
    newTickers,
    isInitialBuild,
  };
}

/** What the Dashboard / Synthesis / Funnel surfaces render. */
export type SuggestedRow = RankedRow & {
  firstSeenAt?: string;
  /** Names first seen at the latest refresh. */
  isNew: boolean;
  /** Positive when the name gained lists since the previous refresh. */
  listDelta: number;
  coverageRequestedAt?: string;
  /** Analyst reports on file (filed date per source), so the coverage column
   *  shows ARRIVALS, not just the request. Joined by the route. */
  reports?: { rbc?: string; jpm?: string; morningstar?: string };
  decision: (DecisionEntry & { expiresOn: string }) | null;
  /** Human reasons the name is IMPROVING (gained a list, SIA percentile up, Equate rank up). */
  improving: string[];
};

export function buildSuggestedRows(
  ranked: RankedRow[],
  store: SuggestedStore,
  decisions: DecisionStore,
  extraImproving: (row: RankedRow) => string[] = () => [],
  nowMs = Date.now(),
): { rows: SuggestedRow[]; passed: SuggestedRow[] } {
  const rows: SuggestedRow[] = [];
  const passed: SuggestedRow[] = [];
  for (const r of qualifyingRows(ranked)) {
    const e = store.entries?.[r.ticker.toUpperCase()];
    const d = activeDecision(decisions, r.ticker, nowMs);
    const listDelta = e?.prevListCount != null ? r.listCount - e.prevListCount : 0;
    const improving = [...(listDelta > 0 ? [`+${listDelta} list${listDelta > 1 ? "s" : ""} since last refresh`] : []), ...extraImproving(r)];
    const row: SuggestedRow = {
      ...r,
      firstSeenAt: e?.firstSeenAt,
      isNew: !!e && !!store.updatedAt && e.firstSeenAt === store.updatedAt,
      listDelta,
      coverageRequestedAt: e?.coverageRequestedAt,
      decision: d ? { ...d, expiresOn: decisionExpiresOn(d) } : null,
      improving,
    };
    (d?.verdict === "pass" ? passed : rows).push(row);
  }
  return { rows, passed };
}
