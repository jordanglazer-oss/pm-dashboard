/**
 * Regime history + label hysteresis.
 *
 * `pm:regime-history` — APPEND-ONLY daily log of the market-regime engine's
 * read: the raw (pre-hysteresis) label, the committed label, the weighted
 * score, every signal's direction, the per-horizon scores, and the SPX / VIX
 * closes at compute time. It exists for two reasons:
 *
 *   1. HYSTERESIS. The canonical label only follows the raw label after it has
 *      read the same way for `HYSTERESIS_CONFIRM_DAYS` consecutive sessions.
 *      One bar can no longer flip the label and regenerate every downstream
 *      call (brief tone, scoring posture suggestion, alerts) for a day.
 *   2. VALIDATION. With SPX logged per row, the question "did Risk-On actually
 *      precede better forward returns than Neutral?" becomes answerable from
 *      our own data, which is the prerequisite to changing any signal, weight
 *      or threshold with evidence rather than taste.
 *
 * Invariants (same family as pm:portfolio-snapshots / pm:score-history):
 *   • one row per Eastern calendar day, TODAY only — a write for any other
 *     date is refused;
 *   • same-day re-computes REPLACE today's row (the engine recomputes every
 *     30 min; the row should reflect the latest read, so the nightly cron's
 *     06:00 UTC pass leaves the prior session's close-of-day read intact);
 *   • past rows are never touched; read-modify-write preserves them verbatim;
 *   • weekend rows are not written (they would just replicate Friday and
 *     inflate the hysteresis streak);
 *   • capped at REGIME_HISTORY_CAP rows (oldest dropped) ≈ six years of
 *     sessions.
 *
 * BACKED UP — deliberately NOT in the backup EXCLUDE_PATTERNS. Losing it
 * loses the validation evidence base.
 */

import { getRedis } from "@/app/lib/redis";
import { easternToday } from "@/app/lib/date-eastern";
import { createLogger } from "@/app/lib/logger";
import type { RegimeDirection, RegimeLabel } from "@/app/lib/market-regime";

const log = createLogger("Regime-history");

export const REGIME_HISTORY_KEY = "pm:regime-history";
export const HYSTERESIS_CONFIRM_DAYS = 3;
export const REGIME_HISTORY_CAP = 1500;

export type RegimeHistoryRow = {
  date: string; // Eastern YYYY-MM-DD
  computedAt: string; // ISO of the engine run this row reflects
  rawLabel: RegimeLabel;
  label: RegimeLabel; // committed (hysteresis applied)
  weightedScore: number | null;
  score100: number | null;
  riskOn: number;
  riskOff: number;
  total: number;
  signals: Record<string, RegimeDirection>;
  horizons: { tactical: number | null; cyclical: number | null; structural: number | null };
  spx: number | null; // ^GSPC close used by the SPX trend signal
  vix: number | null;
};

export type RegimeHistory = { rows: RegimeHistoryRow[] };

function isWeekend(dateStr: string): boolean {
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (isNaN(ms)) return false;
  const d = new Date(ms).getUTCDay();
  return d === 0 || d === 6;
}

/** Ascending by date. Empty array on miss or read error — never seeds. */
export async function readRegimeHistory(): Promise<RegimeHistoryRow[]> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(REGIME_HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Partial<RegimeHistory>;
    const rows = Array.isArray(parsed.rows) ? parsed.rows : [];
    return rows
      .filter((r) => r && typeof r.date === "string")
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  } catch (e) {
    log.error("read error:", e);
    return [];
  }
}

export type HysteresisResult = {
  label: RegimeLabel;
  pending: { label: RegimeLabel; days: number; needed: number } | null;
};

/**
 * Pure. Given today's raw label and the history BEFORE today, decide the
 * committed label. Rules:
 *   • no prior rows → commit the raw label (cold start);
 *   • raw equals the previously committed label → settled, no pending;
 *   • otherwise count the streak of consecutive prior sessions whose RAW label
 *     equals today's raw (plus today) — commit when it reaches `confirmDays`,
 *     else hold the prior committed label and report the pending flip.
 */
export function applyLabelHysteresis(
  rawLabel: RegimeLabel,
  priorRows: readonly RegimeHistoryRow[],
  confirmDays: number = HYSTERESIS_CONFIRM_DAYS
): HysteresisResult {
  if (priorRows.length === 0) return { label: rawLabel, pending: null };
  const prevCommitted = priorRows[priorRows.length - 1].label;
  if (rawLabel === prevCommitted) return { label: rawLabel, pending: null };

  let streak = 1; // today
  for (let i = priorRows.length - 1; i >= 0; i--) {
    if (priorRows[i].rawLabel === rawLabel) streak++;
    else break;
  }
  if (streak >= confirmDays) return { label: rawLabel, pending: null };
  return {
    label: prevCommitted,
    pending: { label: rawLabel, days: streak, needed: confirmDays },
  };
}

/**
 * Upsert TODAY's row. Refuses any other date, skips weekends, preserves every
 * prior row verbatim, caps the array. Never throws — a logging failure must
 * not take the regime endpoint down.
 */
export async function upsertTodayRegimeRow(row: RegimeHistoryRow): Promise<void> {
  const today = easternToday();
  if (row.date !== today) {
    log.warn(`refusing to write row for ${row.date} (today is ${today})`);
    return;
  }
  if (isWeekend(today)) return;
  try {
    const redis = await getRedis();
    const raw = await redis.get(REGIME_HISTORY_KEY);
    const parsed: Partial<RegimeHistory> = raw ? (JSON.parse(raw) as Partial<RegimeHistory>) : {};
    const rows = Array.isArray(parsed.rows) ? parsed.rows.filter((r) => r && typeof r.date === "string") : [];
    const kept = rows.filter((r) => r.date !== today);
    kept.push(row);
    kept.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const capped = kept.length > REGIME_HISTORY_CAP ? kept.slice(kept.length - REGIME_HISTORY_CAP) : kept;
    // Read-merge-write: unknown top-level fields on the blob are preserved.
    await redis.set(REGIME_HISTORY_KEY, JSON.stringify({ ...parsed, rows: capped }));
  } catch (e) {
    log.error("write error:", e);
  }
}
