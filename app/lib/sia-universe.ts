import { getRedis } from "./redis";
import { UNIVERSE_MIN_ROWS, type SiaMovement, type SiaMover, type SiaSnapshot } from "./sia-universe-shared";

// Re-exported so server-side callers keep a single import site.
export { UNIVERSE_MIN_ROWS };
export type { SiaMovement, SiaMover, SiaSnapshot };

/**
 * SIA universe snapshots — weekly SMAX readings for the FULL S&P 500 + TSX
 * export, and the week-over-week movement derived from them.
 *
 * Why this exists separately from applySiaEntries: that helper MATCHES rows
 * against pm:stocks and discards everything else (a ticker not already in the
 * book is pushed to `unmatched` and dropped). That is correct for keeping
 * held names' relativeStrength current, but it means a 1,000-row universe
 * export loses ~96% of its rows and stores no history — so no delta can ever
 * be computed. This module is the second destination: it keeps EVERY row,
 * dated, so movement becomes visible.
 *
 * The movement is the point. A high SMAX level mostly identifies names that
 * are already strong, already covered and already on everyone's list; a SMAX
 * that JUMPED this week is an early, uncrowded trigger — and because SIA
 * covers the whole index rather than a curated list, it is the only source
 * here that can nominate a name no research list mentions.
 *
 * STORAGE — one key per week (pm:sia-snapshot:YYYY-MM-DD) plus a small index
 * (pm:sia-snapshot-index). Deliberately NOT one growing blob: ~1,000 tickers
 * per week would make a single value grow without bound and risk the silent
 * oversized-write failure that pm:attachments was split to avoid. Each weekly
 * write is bounded and independent.
 *
 * APPEND-ONLY, per the CLAUDE.md rule for timeseries data: a snapshot may only
 * be written for TODAY (server UTC date), and an existing date is never
 * overwritten — re-uploading the same week is a no-op, not a clobber.
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
    return []; // read errors degrade to "no history", never to a wrong diff
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
  | { written: true; date: string; tickers: number }
  | { written: false; reason: "too-few-rows" | "already-exists" | "error"; date: string };

/**
 * Persist today's universe snapshot. Refuses to overwrite an existing date
 * (append-only) and refuses sub-universe uploads (see UNIVERSE_MIN_ROWS).
 */
export async function writeSiaSnapshot(rows: Record<string, number>): Promise<WriteResult> {
  const date = todayUtc();
  const count = Object.keys(rows).length;
  if (count < UNIVERSE_MIN_ROWS) return { written: false, reason: "too-few-rows", date };
  try {
    const redis = await getRedis();
    const key = `${SNAP_PREFIX}${date}`;
    if (await redis.get(key)) return { written: false, reason: "already-exists", date };

    const snap: SiaSnapshot = { date, capturedAt: new Date().toISOString(), rows };
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
    return { written: true, date, tickers: count };
  } catch (e) {
    console.error("[sia-universe] snapshot write failed:", e);
    return { written: false, reason: "error", date };
  }
}

/**
 * Week-over-week movement between the two most recent snapshots.
 * `minDelta` is the SMAX change that counts as a move (SMAX is 0-10).
 * Only tickers present in BOTH snapshots produce a delta — a name missing
 * from one side is reported under `added`, never as a fabricated swing.
 */
export async function computeSiaMovement(minDelta = 2): Promise<SiaMovement> {
  const index = await readIndex();
  if (index.length < 2) {
    const to = index[index.length - 1] ?? null;
    return { from: null, to, risers: [], fallers: [], added: [] };
  }
  const toDate = index[index.length - 1];
  const fromDate = index[index.length - 2];
  const [curr, prev] = await Promise.all([readSiaSnapshot(toDate), readSiaSnapshot(fromDate)]);
  if (!curr || !prev) return { from: fromDate, to: toDate, risers: [], fallers: [], added: [] };

  const risers: SiaMover[] = [];
  const fallers: SiaMover[] = [];
  const added: string[] = [];
  for (const [ticker, smax] of Object.entries(curr.rows)) {
    const prior = prev.rows[ticker];
    if (typeof prior !== "number") {
      added.push(ticker);
      continue;
    }
    const delta = smax - prior;
    if (delta >= minDelta) risers.push({ ticker, smax, prior, delta });
    else if (delta <= -minDelta) fallers.push({ ticker, smax, prior, delta });
  }
  risers.sort((a, b) => b.delta - a.delta || b.smax - a.smax || a.ticker.localeCompare(b.ticker));
  fallers.sort((a, b) => a.delta - b.delta || a.smax - b.smax || a.ticker.localeCompare(b.ticker));
  added.sort();
  return { from: fromDate, to: toDate, risers, fallers, added };
}
