/**
 * Client-safe half of the SIA universe module — constants and types only, no
 * Redis import. Same split (and same reason) as street-takeaways-shared and
 * brief-progress-shared: app/lib/sia-universe.ts imports the redis client, so
 * a "use client" component importing a VALUE from it would drag the node
 * redis package into the browser bundle and fail the Turbopack build.
 */

/**
 * Minimum rows for an upload to count as a UNIVERSE snapshot. A 40-row
 * watchlist export must not become a snapshot: it would land as the newest
 * one and the next diff would compare ~1,000 tickers against 40, reporting
 * ~960 phantom disappearances. Universe exports are ~500 (S&P) to ~1,500
 * (S&P + TSX), so this cleanly separates the two use cases.
 */
export const UNIVERSE_MIN_ROWS = 200;

/**
 * Recognise a NAMED index export from the subject or filename.
 *
 * The row-count gate alone excludes the TSX 60 — 60 rows, far under the
 * threshold — even though it is exactly the kind of broad universe the
 * suggested watchlist wants: improving relative strength across an index the
 * PM does not already own. Lowering the threshold is not the fix; it would
 * reopen the bug the threshold exists for (a 40-row watchlist export landing
 * as the newest snapshot, making the next diff report ~960 phantom drops).
 *
 * So size stops being the only evidence: a file that NAMES its index is
 * treated as a universe at any size. "Watchlist" and "portfolio" exports are
 * refused outright regardless of what else the name contains, since those are
 * holdings reports and must never become a snapshot.
 */
export function isNamedUniverseExport(label: string | undefined): boolean {
  // Strip every separator before matching. Word boundaries do not work here:
  // underscore IS a word character and "TSX60" has no boundary inside it, so
  // \b-based patterns miss exactly what an unedited download is called
  // (SIA_TSX60.csv, SIA_SP500.csv). Same trap the SIA subject matcher hit.
  const flat = (label ?? "").toLowerCase().replace(/[^a-z0-9&]/g, "");
  if (!flat) return false;
  // Holdings reports can never be a snapshot, whatever else they are called.
  if (/watchlist|portfolio|holdings/.test(flat)) return false;
  return /tsx|sp500|s&p500|spx|nasdaq100|russell|universe|index/.test(flat);
}


/**
 * One name's reading in a weekly universe export.
 *
 * `rank` and the CHG fields are the load-bearing ones. SMAX is a 0-10 integer,
 * so across ~750 names hundreds tie at 8/9/10 — too coarse to rank a universe
 * or to detect movement inside the top tier. Rank is continuous, and SIA
 * publishes its change directly, so momentum is readable from a single upload.
 *
 * SIGN CONVENTION: a POSITIVE change is an IMPROVEMENT (the name climbed that
 * many places). Confirmed by the data — a name sitting at rank 1 with a
 * quarterly change of +96 came FROM rank 97; a name at rank 5 with a weekly
 * change of -2 slipped from rank 3.
 */
export type SiaRow = {
  smax?: number;
  rank?: number;
  /** Size of the ranked block this row came from (504 = S&P 500, 62 = TSX).
   *  The two index files merge into ONE snapshot, so without this a rank is
   *  not interpretable: 60th of 62 is the bottom of the TSX, 60th of 504 is
   *  the top decile of the S&P. Absent on snapshots written before this
   *  field existed — callers must handle undefined. */
  universeSize?: number;
  /** SIA's relative-strength percentile (0-100) when the source carried it. */
  percentile?: number;
  /** Places climbed over each window; negative = slipped. */
  dChg?: number;
  wChg?: number;
  mChg?: number;
  qChg?: number;
  sector?: string;
};

export type SiaSnapshot = {
  /** YYYY-MM-DD the snapshot was captured (server UTC). */
  date: string;
  capturedAt: string;
  /** TICKER → reading. Uppercased, slash/$-normalized by the parser. */
  rows: Record<string, SiaRow>;
};

/** A name whose rank improved, carrying the level it improved to. */
export type SiaMover = {
  ticker: string;
  rank: number;
  wChg: number;
  smax: number | null;
  sector: string | null;
};

export type SiaMoverResult = {
  /** Snapshot the movers were read from; null when none exists yet. */
  date: string | null;
  movers: SiaMover[];
  /** Names in the snapshot at all — context for "N of M". */
  universeSize: number;
};

/**
 * Minimum rows for a file to be judged an index cut on its CONTENTS alone.
 *
 * Deliberately well above the largest holdings report seen in the wild (a
 * 43-row SIA export of the PM's own names), so those are refused on size
 * before contiguity is even considered, and comfortably below the TSX 60
 * (62 rows including index funds). Both tests must pass, so a holdings report
 * would have to be both large and re-ranked from 1 to slip through.
 */
export const INDEX_CUT_MIN_ROWS = 50;

/**
 * Third form of evidence that a file is a universe export: it is a COMPLETE
 * ranked block.
 *
 * The row-count gate misses the TSX 60, and the name gate only fires when the
 * file says which index it is — which an unedited SIA download never does
 * ("tableExport-7.csv"). Asking the PM to rename every download defeats the
 * point of ingesting mail automatically.
 *
 * A full index export ranks its members 1..N with no gaps. A holdings or
 * watchlist report carries each name's rank WITHIN the universe instead, so
 * its ranks are scattered (3, 17, 88, 204, 431...) and never form a block
 * from 1. That is the discriminator, and it does not depend on how many of
 * the names the PM happens to own — a size-vs-overlap heuristic would quietly
 * stop recognising the TSX 60 as the watchlist grew into it.
 */
export function looksLikeCompleteIndexCut(ranks: Array<number | null | undefined>): boolean {
  const clean = ranks.filter((r): r is number => typeof r === "number" && Number.isFinite(r));
  if (clean.length < INDEX_CUT_MIN_ROWS) return false;
  // Every row must carry a rank; a partially-ranked file is not a clean cut.
  if (clean.length !== ranks.length) return false;
  const unique = new Set(clean);
  if (unique.size !== clean.length) return false;
  return Math.min(...clean) === 1 && Math.max(...clean) === clean.length;
}
