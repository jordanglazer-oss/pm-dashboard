import { getRedis } from "./redis";
import {
  UNIVERSE_MIN_ROWS,
  isNamedUniverseExport,
  type SiaMover,
  type SiaMoverResult,
  type SiaRow,
  type SiaSnapshot,
} from "./sia-universe-shared";

// Re-exported so server-side callers keep a single import site.
export { UNIVERSE_MIN_ROWS, isNamedUniverseExport };
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
 * its D/W/M/Q change, so the mover list is readable from a SINGLE upload with
 * no baseline week — which is why only the newest export needs storing.
 */

/**
 * ONE key, always the newest export. Deliberately not a weekly archive: the
 * nightly cron serializes all of Redis into a Vercel Blob, so every key kept
 * here is re-written to Blob every night and counts against Blob storage and
 * transfer — a year of weekly snapshots would be copied ~14 times over at any
 * moment. The lane only ever reads the newest export anyway, because SIA
 * publishes the rank change in the file itself.
 *
 * Cost of the choice: no history to test later whether rank momentum
 * predicted returns. If that becomes wanted, store the derived MOVER LIST
 * weekly (a few hundred bytes) rather than the full ~750-row universe.
 */
const SNAP_KEY = "pm:sia-universe";

const todayUtc = () => new Date().toISOString().slice(0, 10);

/** The stored export, or null when none has landed yet. */
export async function readSiaSnapshot(): Promise<SiaSnapshot | null> {
  try {
    const raw = await (await getRedis()).get(SNAP_KEY);
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
export async function writeSiaSnapshot(
  rows: Record<string, SiaRow>,
  opts?: { /** The export names its index, so accept it at any size. */ named?: boolean },
): Promise<WriteResult> {
  const date = todayUtc();
  const count = Object.keys(rows).length;
  if (count < UNIVERSE_MIN_ROWS && !opts?.named) return { written: false, reason: "too-few-rows", date };
  try {
    const redis = await getRedis();

    // Same day → MERGE (the S&P and TSX arrive as separate files, and the
    // ingest route POSTs one attachment per request, so the second file must
    // add to the first). A later date → REPLACE, so only the newest export is
    // ever stored.
    let merged = false;
    let combined = rows;
    const existingRaw = await redis.get(SNAP_KEY);
    if (existingRaw) {
      try {
        const prior = JSON.parse(existingRaw) as SiaSnapshot;
        if (prior?.date === date && prior.rows && typeof prior.rows === "object") {
          combined = { ...prior.rows, ...rows }; // newer file wins per ticker
          merged = true;
        }
      } catch {
        // Unparseable existing value — replace rather than lose today's upload.
      }
    }

    const snap: SiaSnapshot = { date, capturedAt: new Date().toISOString(), rows: combined };
    await redis.set(SNAP_KEY, JSON.stringify(snap));
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
  const snap = await readSiaSnapshot();
  if (!snap?.rows) return { date: snap?.date ?? null, movers: [], universeSize: 0 };
  const date = snap.date;

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
