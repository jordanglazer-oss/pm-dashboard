/**
 * Append-only per-ticker log of SIA relative-strength readings.
 *
 * WHY THIS EXISTS. `stock.sia` holds the latest SMAX and nothing else, so the
 * dashboard can say what a name's technical score IS but never what it was
 * doing. SMAX is also a 0-10 integer, which is too coarse to detect drift:
 * a name can slide from the 91st percentile to the 62nd and still read "10".
 * The holdings exports carry SIA's own percentile alongside SMAX, and logging
 * it weekly turns a point reading into a trend — which is the input a kill
 * condition or a deterioration alert actually needs.
 *
 * SMAX IS UNCHANGED AS A SCORING INPUT. Nothing here feeds `relativeStrength`
 * or any other score; `mapSmaxToRelativeStrength` remains the only path from
 * SIA into the composite. This log is monitoring evidence, deliberately kept
 * to the side of the scoring system.
 *
 * SCOPE: names the PM holds (Portfolio + Watchlist) only — roughly 64 rows a
 * week, not the 566-row universe. The universe snapshot already keeps the
 * broad cut, and logging every index name weekly would grow this key without
 * serving the question it exists to answer ("is one of MY names rolling
 * over?"). Redis has OOM'd on accumulated bulk before; this stays small by
 * construction.
 *
 * SAFETY INVARIANTS (mirroring pm:score-history and pm:portfolio-snapshots):
 *   1. Reads return {} on a missing key or a read error — never seed.
 *   2. One entry per ticker per DAY; a second write the same day is ignored
 *      rather than overwriting, so a re-upload can't rewrite history.
 *   3. Past-dated entries are rejected by the route.
 *   4. Read-merge-write — other tickers' arrays are always preserved.
 *   5. No delete path.
 */

import { getRedis } from "./redis";

export const SIA_HISTORY_KEY = "pm:sia-history";

export type SiaHistoryEntry = {
  /** YYYY-MM-DD, server UTC. */
  date: string;
  timestamp: string;
  /** SIA SMAX 0-10, as ingested. */
  smax?: number;
  /** SIA's relative-strength percentile 0-100 (holdings exports carry this). */
  percentile?: number;
  /** Position within an index export, when the reading came from one. */
  rank?: number;
  /** Size of the ranked block `rank` refers to — 504 (S&P) / 62 (TSX). */
  universeSize?: number;
};

export type SiaHistoryStore = Record<string, SiaHistoryEntry[]>;

/** How many readings to keep per ticker. Weekly cadence, so this is ~4 years
 *  — long enough for any trend question, bounded so the key can't creep. */
const MAX_ENTRIES_PER_TICKER = 220;

export async function readSiaHistory(): Promise<SiaHistoryStore> {
  try {
    const raw = await (await getRedis()).get(SIA_HISTORY_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as SiaHistoryStore) : {};
  } catch {
    return {};
  }
}

export type AppendResult = { appended: number; skipped: number; tickers: number };

/**
 * Append today's readings, one per ticker, skipping any ticker that already
 * has an entry for `date`.
 *
 * Skipping rather than overwriting is deliberate: all four SIA exports arrive
 * in one email as separate webhook calls, and the same name appears in both a
 * holdings export and an index export. The FIRST reading of the day wins, so
 * re-uploading a file or the batch arriving out of order can never rewrite a
 * day that is already recorded.
 */
export async function appendSiaHistory(
  readings: Record<string, Omit<SiaHistoryEntry, "date" | "timestamp">>,
  opts?: { date?: string; now?: string },
): Promise<AppendResult> {
  const date = opts?.date ?? new Date().toISOString().slice(0, 10);
  const timestamp = opts?.now ?? new Date().toISOString();
  const tickers = Object.keys(readings);
  if (tickers.length === 0) return { appended: 0, skipped: 0, tickers: 0 };

  const redis = await getRedis();
  const store = await readSiaHistory();
  let appended = 0;
  let skipped = 0;

  for (const [tickerRaw, reading] of Object.entries(readings)) {
    const ticker = tickerRaw.toUpperCase();
    // A reading with no numbers in it is not evidence of anything.
    if (reading.smax == null && reading.percentile == null && reading.rank == null) continue;
    const prior = Array.isArray(store[ticker]) ? store[ticker] : [];
    if (prior.some((e) => e?.date === date)) {
      skipped++;
      continue;
    }
    const next = [...prior, { date, timestamp, ...reading }];
    // Trim from the FRONT so the newest readings are the ones kept.
    store[ticker] = next.length > MAX_ENTRIES_PER_TICKER ? next.slice(next.length - MAX_ENTRIES_PER_TICKER) : next;
    appended++;
  }

  if (appended > 0) await redis.set(SIA_HISTORY_KEY, JSON.stringify(store));
  return { appended, skipped, tickers: tickers.length };
}

/**
 * The percentile move for one ticker between the reading current at
 * `windowStartMs` and its latest reading.
 *
 * Baseline is the last entry PREDATING the window (the state entering it),
 * matching how change-monitor reads score history, so the comparison slides
 * forward as the log grows rather than drifting against a fixed point.
 */
export type SiaDrift = {
  ticker: string;
  from: number;
  to: number;
  delta: number;
  fromDate: string;
  toDate: string;
  /** SMAX at each end — the point of the signal is that this often hasn't moved. */
  smaxFrom?: number;
  smaxTo?: number;
};

export function siaPercentileDrift(
  entriesRaw: SiaHistoryEntry[] | undefined,
  ticker: string,
  windowStartMs: number,
): SiaDrift | null {
  const entries = (entriesRaw ?? [])
    .filter((e) => e && typeof e.percentile === "number" && typeof e.timestamp === "string")
    .slice()
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  if (entries.length < 2) return null;

  const latest = entries[entries.length - 1];
  let baseline: SiaHistoryEntry | undefined;
  for (const e of entries) {
    if (Date.parse(e.timestamp) < windowStartMs) baseline = e;
  }
  if (!baseline) baseline = entries[0];
  if (baseline === latest) return null;

  const from = baseline.percentile as number;
  const to = latest.percentile as number;
  return {
    ticker,
    from,
    to,
    delta: to - from,
    fromDate: baseline.date,
    toDate: latest.date,
    smaxFrom: baseline.smax,
    smaxTo: latest.smax,
  };
}
