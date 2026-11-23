import type { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import type { ResearchState } from "./defaults";
import { rankResearch, type RankedListKey, type RankedRow } from "./research-ranked";

/**
 * pm:ranked-source-history — APPEND-ONLY record of WHEN each name appeared on
 * (and dropped off) each research list, and when it first reached the top of
 * the ranked table (Nov 2026, meeting item 9).
 *
 * Exists because pm:research holds only today's lists: nothing recorded when
 * a name first showed up, so "new this week" and "performance since it
 * reached the top" could not be answered.
 *
 * Shape: { startedAt, tickers: { [rootKey]: { ticker, lists: { [listKey]:
 * Span[] }, top: Span[] } } } — a Span is { from, to?, baseline? }; an open
 * span (no `to`) means "on it now". `top` spans cover the days the name sat
 * on TOP_MIN_LISTS or more bullish lists.
 *
 * Single writer: `recordRankedHistory`, a WRITE-ASIDE called right after
 * each write of pm:research (the Sources page save, the emailed-list ingest,
 * the Lee-note Core-list update). It never changes what is saved to
 * pm:research and never throws.
 *
 * Rules: every change is dated TODAY (Eastern) — a span opens today or is
 * closed today, earlier spans are never touched. The FIRST run records what
 * is on the lists as `baseline` (from = the list's own dateAdded when it
 * carries one, else today), so the whole table is not marked "new". A list
 * that comes back completely empty while it had MIN_GUARD or more open names
 * is treated as a failed read and closes nothing. A corrupt blob is left
 * alone. Monitoring only — it never feeds a score.
 */

const log = createLogger("Ranked-history");
export const RANKED_HISTORY_KEY = "pm:ranked-source-history";
/** "Top of the ranked list" = on this many bullish lists (the notes' "3+ lists"). */
export const TOP_MIN_LISTS = 3;
/** On this many lists a name is "crowded" (crowded names fall hardest in sell-offs). */
export const CROWDED_MIN_LISTS = 5;
const MIN_GUARD = 3;

export type Span = { from: string; to?: string; baseline?: true };
export type RankedTickerHistory = { ticker: string; lists: Partial<Record<RankedListKey, Span[]>>; top: Span[] };
export type RankedHistory = { startedAt: string; tickers: Record<string, RankedTickerHistory> };

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}/.test(s);
const openSpan = (spans: Span[] | undefined) => (spans?.length && !spans[spans.length - 1].to ? spans[spans.length - 1] : undefined);
export const etDay = (d: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);

/** Open a span today (or re-open one closed earlier TODAY rather than stack a second). */
function open(spans: Span[], today: string, baselineFrom?: string): Span[] {
  const last = spans[spans.length - 1];
  if (last && !last.to) return spans;
  if (last && last.to === today && !baselineFrom) return [...spans.slice(0, -1), { from: last.from, ...(last.baseline ? { baseline: true as const } : {}) }];
  return [...spans, baselineFrom ? { from: baselineFrom, baseline: true as const } : { from: today }];
}
function close(spans: Span[], today: string): Span[] {
  const last = spans[spans.length - 1];
  if (!last || last.to) return spans;
  return [...spans.slice(0, -1), { ...last, to: today }];
}

/** Pure merge of today's ranked rows into the history. `rows` = rankResearch(research). */
export function mergeRankedHistory(prev: RankedHistory | null, rows: RankedRow[], today: string): { next: RankedHistory; changed: number } {
  const first = !prev;
  const next: RankedHistory = { startedAt: prev?.startedAt ?? today, tickers: { ...(prev?.tickers ?? {}) } };
  let changed = 0;

  // Which (root, list) pairs are on the lists today, and how full each list is.
  const present = new Map<string, Map<RankedListKey, string | undefined>>();
  const listSize = new Map<RankedListKey, number>();
  for (const r of rows) {
    const m = new Map<RankedListKey, string | undefined>();
    for (const ref of [...r.lists, ...r.bearish]) {
      m.set(ref.key, ref.dateAdded);
      listSize.set(ref.key, (listSize.get(ref.key) ?? 0) + 1);
    }
    present.set(r.key, m);
  }
  // Open names per list on file — for the "list came back empty" guard.
  const openOnFile = new Map<RankedListKey, number>();
  for (const t of Object.values(next.tickers)) for (const [k, spans] of Object.entries(t.lists) as [RankedListKey, Span[]][]) if (openSpan(spans)) openOnFile.set(k, (openOnFile.get(k) ?? 0) + 1);
  const suspect = (k: RankedListKey) => !listSize.get(k) && (openOnFile.get(k) ?? 0) >= MIN_GUARD;

  const rowByKey = new Map(rows.map((r) => [r.key, r]));
  for (const key of new Set([...Object.keys(next.tickers), ...rows.map((r) => r.key)])) {
    const row = rowByKey.get(key);
    const cur = next.tickers[key];
    const t: RankedTickerHistory = cur ? { ticker: row?.ticker ?? cur.ticker, lists: { ...cur.lists }, top: cur.top ?? [] } : { ticker: row?.ticker ?? key, lists: {}, top: [] };
    const before = JSON.stringify([t.lists, t.top]);
    const on = present.get(key) ?? new Map<RankedListKey, string | undefined>();

    for (const [listKey, dateAdded] of on) {
      const spans = t.lists[listKey] ?? [];
      if (openSpan(spans)) continue;
      const baselineFrom = first ? (isDate(dateAdded) && dateAdded.slice(0, 10) <= today ? dateAdded.slice(0, 10) : today) : undefined;
      t.lists[listKey] = open(spans, today, baselineFrom);
    }
    let guarded = 0;
    for (const [listKey, spans] of Object.entries(t.lists) as [RankedListKey, Span[]][]) {
      if (on.has(listKey) || !openSpan(spans)) continue;
      if (suspect(listKey)) {
        guarded++; // list read as empty — keep the span, and keep counting it
        continue;
      }
      t.lists[listKey] = close(spans, today);
    }

    // "Top" = on TOP_MIN_LISTS+ bullish lists (a guarded list still counts as on).
    const isTop = (row ? row.listCount : 0) + guarded >= TOP_MIN_LISTS;
    if (isTop && !openSpan(t.top)) t.top = open(t.top, today, first ? today : undefined);
    else if (!isTop && openSpan(t.top)) t.top = close(t.top, today);

    if (!cur && !Object.keys(t.lists).length) continue;
    if (!cur || JSON.stringify([t.lists, t.top]) !== before) {
      next.tickers[key] = t;
      changed++;
    }
  }
  return { next, changed };
}

/** Write-aside after a pm:research write. Never throws; returns tickers changed. */
export async function recordRankedHistory(redis: Awaited<ReturnType<typeof getRedis>>, research: unknown): Promise<number> {
  try {
    if (!research || typeof research !== "object" || Array.isArray(research)) return 0;
    const rows = rankResearch(research as Partial<ResearchState>, []);
    if (!rows.length) return 0; // nothing on any list — a failed read, not "everything dropped"
    const raw = await redis.get(RANKED_HISTORY_KEY);
    let prev: RankedHistory | null = null;
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      const ok = !!parsed && typeof parsed === "object" && !Array.isArray(parsed) && typeof (parsed as RankedHistory).tickers === "object" && (parsed as RankedHistory).tickers !== null;
      if (!ok) {
        log.warn("unexpected shape on file — left alone");
        return 0;
      }
      prev = parsed as RankedHistory;
    }
    const { next, changed } = mergeRankedHistory(prev, rows, etDay());
    if (changed > 0 || !prev) await redis.set(RANKED_HISTORY_KEY, JSON.stringify(next));
    return changed;
  } catch (e) {
    log.error("write-aside failed (the research save is unaffected):", e);
    return 0;
  }
}

export type RankedTracking = {
  /** Earliest date it has been continuously on a bullish list (open spans only). */
  since: string | null;
  /** True when that date is only where our tracking started, not a known first appearance. */
  sinceIsBaseline: boolean;
  /** Bullish lists it joined in the last `newDays` days (not baseline). */
  newOn: RankedListKey[];
  /** Date it reached the top (open `top` span), and whether that is a baseline date. */
  topSince: string | null;
  topIsBaseline: boolean;
};

/** Read one row's history for the table. Pure. */
export function trackingFor(history: RankedHistory | null | undefined, row: RankedRow, today: string, newDays = 7): RankedTracking {
  const t = history?.tickers?.[row.key];
  const out: RankedTracking = { since: null, sinceIsBaseline: false, newOn: [], topSince: null, topIsBaseline: false };
  if (!t) return out;
  const cutoff = new Date(Date.parse(today) - newDays * 86_400_000).toISOString().slice(0, 10);
  for (const ref of row.lists) {
    const s = openSpan(t.lists[ref.key]);
    if (!s) continue;
    if (!out.since || s.from < out.since) {
      out.since = s.from;
      out.sinceIsBaseline = !!s.baseline;
    }
    if (!s.baseline && s.from > cutoff) out.newOn.push(ref.key);
  }
  const top = openSpan(t.top);
  if (top) {
    out.topSince = top.from;
    out.topIsBaseline = !!top.baseline;
  }
  return out;
}
