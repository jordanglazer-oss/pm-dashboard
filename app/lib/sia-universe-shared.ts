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

export type SiaSnapshot = {
  /** YYYY-MM-DD the snapshot was captured (server UTC). */
  date: string;
  capturedAt: string;
  /** TICKER → SMAX (0-10). Uppercased, slash/$-normalized by the parser. */
  rows: Record<string, number>;
};

export type SiaMover = {
  ticker: string;
  smax: number;
  prior: number;
  delta: number;
};

export type SiaMovement = {
  /** Dates compared, newest first. Null when there aren't two snapshots yet. */
  from: string | null;
  to: string | null;
  risers: SiaMover[];
  fallers: SiaMover[];
  /** Tickers present in the new snapshot but absent from the prior one —
   *  reported separately because a brand-new listing is not a "riser". */
  added: string[];
};
