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
