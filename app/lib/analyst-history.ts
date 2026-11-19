import type { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";

/**
 * pm:analyst-history — APPEND-ONLY per-ticker log of the sell-side consensus
 * (Nov 2026): `{ [TICKER]: AnalystReading[] }`, oldest first.
 *
 * Exists because pm:analyst-snapshots holds only the LATEST FactSet mean
 * target, analyst count and 30-day EPS revisions, so "the target has been cut
 * three months running" or "coverage is thinning" could not be seen. Tracked
 * for every Portfolio + Watchlist name, independent of scoring — nothing here
 * ever feeds a score.
 *
 * Single writer: `appendAnalystHistory`, called by the nightly FactSet
 * estimates refresh AFTER it has saved pm:analyst-snapshots. A write-aside:
 * it never changes the snapshots and never throws.
 *
 * Rules (same invariant as pm:sia-history): today's date only; one entry per
 * ticker per day and the FIRST reading of a day wins; a reading identical to
 * the ticker's last entry is not stored (the log records CHANGES, so a quiet
 * name stays small); capped at MAX_PER_TICKER. Past entries are never
 * rewritten. A corrupt or unexpected blob is left alone.
 */

const log = createLogger("Analyst-history");
export const ANALYST_HISTORY_KEY = "pm:analyst-history";
const MAX_PER_TICKER = 400;

export type AnalystReading = {
  date: string; // YYYY-MM-DD (server UTC, as the refresh stamps it)
  /** FactSet mean target price. */
  target?: number;
  /** Number of FY+1 estimates (the analyst count). */
  count?: number;
  /** EPS FY+1 revisions over the last 30 days, up / down. */
  revUp?: number;
  revDown?: number;
};
export type AnalystHistory = Record<string, AnalystReading[]>;
export type AnalystInput = { target?: number | null; count?: number | null; revUp?: number | null; revDown?: number | null };

const num = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const same = (a: AnalystReading, b: AnalystReading) => a.target === b.target && a.count === b.count && a.revUp === b.revUp && a.revDown === b.revDown;

/** Pure merge: returns the next blob and how many entries were added. */
export function mergeAnalystHistory(prev: AnalystHistory, readings: Record<string, AnalystInput>, today: string): { next: AnalystHistory; added: number } {
  const next: AnalystHistory = { ...prev };
  let added = 0;
  for (const [rawTicker, r] of Object.entries(readings)) {
    const ticker = rawTicker.trim().toUpperCase();
    if (!ticker) continue;
    const entry: AnalystReading = { date: today };
    const target = num(r.target), count = num(r.count), revUp = num(r.revUp), revDown = num(r.revDown);
    if (target !== undefined) entry.target = target;
    if (count !== undefined) entry.count = count;
    if (revUp !== undefined) entry.revUp = revUp;
    if (revDown !== undefined) entry.revDown = revDown;
    if (entry.target === undefined && entry.count === undefined) continue; // nothing worth a row
    const list = Array.isArray(next[ticker]) ? next[ticker] : [];
    const last = list[list.length - 1];
    if (last && (last.date >= today || same(last, entry))) continue; // first of the day wins; no-change not stored
    next[ticker] = [...list, entry].slice(-MAX_PER_TICKER);
    added++;
  }
  return { next, added };
}

/** Append today's readings. Never throws; returns entries added (0 on any problem). */
export async function appendAnalystHistory(redis: Awaited<ReturnType<typeof getRedis>>, readings: Record<string, AnalystInput>, today: string): Promise<number> {
  try {
    if (!Object.keys(readings).length) return 0;
    const raw = await redis.get(ANALYST_HISTORY_KEY);
    let prev: AnalystHistory = {};
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        log.warn("unexpected shape on file — left alone");
        return 0;
      }
      prev = parsed as AnalystHistory;
    }
    const { next, added } = mergeAnalystHistory(prev, readings, today);
    if (added > 0) await redis.set(ANALYST_HISTORY_KEY, JSON.stringify(next));
    return added;
  } catch (e) {
    log.error("append failed (the estimates refresh is unaffected):", e);
    return 0;
  }
}

export type AnalystTrend = {
  latest: AnalystReading | null;
  /** Change vs the last reading on or before N days ago (null when no reading that old). */
  d30: { targetPct: number | null; count: number | null } | null;
  d90: { targetPct: number | null; count: number | null } | null;
  /** Consecutive target cuts / raises ending at the latest reading. */
  targetStreak: { direction: "up" | "down"; changes: number } | null;
};

/** Read a ticker's log as a trend. Pure. */
export function analystTrend(entries: AnalystReading[] | undefined, today: string): AnalystTrend {
  const list = entries ?? [];
  const latest = list[list.length - 1] ?? null;
  const back = (days: number) => {
    if (!latest) return null;
    const cut = new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10);
    const ref = [...list].reverse().find((e) => e.date <= cut);
    if (!ref) return null;
    return {
      targetPct: latest.target != null && ref.target != null && ref.target > 0 ? parseFloat(((latest.target / ref.target - 1) * 100).toFixed(2)) : null,
      count: latest.count != null && ref.count != null ? latest.count - ref.count : null,
    };
  };
  const targets = list.filter((e) => e.target != null).map((e) => e.target!);
  let streak: AnalystTrend["targetStreak"] = null;
  for (let i = targets.length - 1; i > 0; i--) {
    if (targets[i] === targets[i - 1]) continue;
    const dir = targets[i] > targets[i - 1] ? "up" : "down";
    if (!streak) streak = { direction: dir, changes: 1 };
    else if (streak.direction === dir) streak.changes++;
    else break;
  }
  return { latest, d30: back(30), d90: back(90), targetStreak: streak };
}
