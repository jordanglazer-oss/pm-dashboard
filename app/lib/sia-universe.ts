import { getRedis } from "./redis";
import {
  UNIVERSE_MIN_ROWS,
  type SiaMover,
  type SiaMoverResult,
  type SiaRow,
  type SiaSnapshot,
} from "./sia-universe-shared";

// Re-exported so server-side callers keep a single import site.
export { UNIVERSE_MIN_ROWS };
export type { SiaMover, SiaMoverResult, SiaRow, SiaSnapshot };

/**
 * SIA universe snapshots — the weekly S&P 500 / TSX ranked export.
 *
 * Why this exists separately from applySiaEntries: that helper MATCHES rows
 * against pm:stocks and discards everything else, which is right for keeping
 * held names' relativeStrength current but loses ~96% of a universe export.
 * This module keeps EVERY row, so a name you don't own can be surfaced.
 *
 * MOMENTUM COMES FROM THE FILE, NOT FROM DIFFING. The export carries RANK plus
 * its D/W/M/Q change, so the weekly mover list is readable from a SINGLE
 * upload — no two-week baseline. Snapshots are still stored because they are
 * the only way to study whether rank momentum predicted returns later, and
 * because SIA's own change columns only reach back one quarter.
 *
 * STORAGE — one key per week (pm:sia-snapshot:YYYY-MM-DD) plus a small index
 * (pm:sia-snapshot-index). Deliberately NOT one growing blob: ~750 tickers a
 * week would make a single value grow without bound and risk the silent
 * oversized-write failure that pm:attachments was split to avoid.
 *
 * Writes only ever target TODAY, so no past week can be rewritten; within
 * today they MERGE, because the S&P and TSX arrive as separate files.
 */

const SNAP_PREFIX = "pm:sia-snapshot:";
const INDEX_KEY = "pm:sia-snapshot-index";

/** Keep ~1 year of weekly snapshots. */
const MAX_SNAPSHOTS = 60;

const todayUtc = () => new Date().toISOString().slice(0, 10);

async function readIndex(): Promise<string[]> {
  try {
    const raw = await (await getRedis()).get(INDEX_KEY);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(arr) ? arr.filter((d): d is string => typeof d === "string").sort() : [];
  } catch {
    return []; // read errors degrade to "no history", never to a wrong answer
  }
}

/** Snapshot dates, oldest first. */
export async function listSiaSnapshots(): Promise<string[]> {
  return readIndex();
}

export async function readSiaSnapshot(date: string): Promise<SiaSnapshot | null> {
  try {
    const raw = await (await getRedis()).get(`${SNAP_PREFIX}${date}`);
    return raw ? (JSON.parse(raw) as SiaSnapshot) : null;
  } catch {
    return null;
  }
}

export type WriteResult =
  | { written: true; date: string; tickers: number; merged: boolean }
  | { written: false; reason: "too-few-rows" | "error"; date: string };

/**
 * Persist today's universe snapshot, MERGING into an existing one for the
 * same date. Merging is required, not a nicety: the S&P 500 and TSX arrive as
 * separate files and the ingest route POSTs one attachment per request, so
 * the second universe file of the day must add to the first rather than be
 * rejected — rejecting it silently dropped an entire index.
 */
export async function writeSiaSnapshot(rows: Record<string, SiaRow>): Promise<WriteResult> {
  const date = todayUtc();
  const count = Object.keys(rows).length;
  if (count < UNIVERSE_MIN_ROWS) return { written: false, reason: "too-few-rows", date };
  try {
    const redis = await getRedis();
    const key = `${SNAP_PREFIX}${date}`;

    const existingRaw = await redis.get(key);
    let merged = false;
    let combined = rows;
    if (existingRaw) {
      try {
        const prior = JSON.parse(existingRaw) as SiaSnapshot;
        if (prior?.rows && typeof prior.rows === "object") {
          combined = { ...prior.rows, ...rows }; // newer file wins per ticker
          merged = true;
        }
      } catch {
        // Unparseable existing value — replace rather than lose today's upload.
      }
    }

    const snap: SiaSnapshot = { date, capturedAt: new Date().toISOString(), rows: combined };
    await redis.set(key, JSON.stringify(snap));

    const index = await readIndex();
    if (!index.includes(date)) index.push(date);
    index.sort();
    // Prune oldest beyond the retention window (delete the value, then the
    // index entry — an orphaned key is harmless, a dangling index entry isn't).
    while (index.length > MAX_SNAPSHOTS) {
      const drop = index.shift();
      if (drop) await redis.del(`${SNAP_PREFIX}${drop}`).catch(() => {});
    }
    await redis.set(INDEX_KEY, JSON.stringify(index));
    return { written: true, date, tickers: Object.keys(combined).length, merged };
  } catch (e) {
    console.error("[sia-universe] snapshot write failed:", e);
    return { written: false, reason: "error", date };
  }
}

/**
 * Names whose SIA rank IMPROVED over the past week, read straight from the
 * newest snapshot's own W CHG column.
 *
 * `minSmax` is a quality gate, and it earns its place: rank momentum alone
 * would be dominated by names climbing out of the bottom of the ranking, which
 * is noise for an idea funnel. Requiring a decent SMAX turns the list into
 * "already-strong names still improving".
 */
export async function latestSiaMovers(opts?: {
  minWChg?: number;
  minSmax?: number;
}): Promise<SiaMoverResult> {
  const minWChg = opts?.minWChg ?? 20;
  const minSmax = opts?.minSmax ?? 7;
  const index = await readIndex();
  const date = index[index.length - 1] ?? null;
  if (!date) return { date: null, movers: [], universeSize: 0 };
  const snap = await readSiaSnapshot(date);
  if (!snap?.rows) return { date, movers: [], universeSize: 0 };

  const movers: SiaMover[] = [];
  for (const [ticker, row] of Object.entries(snap.rows)) {
    if (typeof row?.wChg !== "number" || row.wChg < minWChg) continue;
    if (typeof row.rank !== "number") continue;
    if (typeof row.smax === "number" && row.smax < minSmax) continue;
    movers.push({
      ticker,
      rank: row.rank,
      wChg: row.wChg,
      smax: typeof row.smax === "number" ? row.smax : null,
      sector: row.sector ?? null,
    });
  }
  // Biggest climb first; ties resolved by the better (lower) rank reached.
  movers.sort((a, b) => b.wChg - a.wChg || a.rank - b.rank || a.ticker.localeCompare(b.ticker));
  return { date, movers, universeSize: Object.keys(snap.rows).length };
}
