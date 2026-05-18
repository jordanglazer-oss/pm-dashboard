/**
 * Maps raw external-tool scores (BoostedAI rating + consensus, SIA SMAX)
 * into the dashboard's internal 0-2 scoring categories (aiRating,
 * relativeStrength).
 *
 * Used by the Inbox-tab Coverage Checklist edits and any future bulk-entry
 * surfaces — the PM enters the raw tool output, and the composite scoring
 * system automatically picks up the derived value.
 */

export type BoostedAiConsensus =
  | "strong-buy"
  | "buy"
  | "hold"
  | "sell"
  | "strong-sell";

/**
 * BoostedAI consensus → 0-2 bucket.
 *   Strong Buy / Buy → 2
 *   Hold            → 1
 *   Sell / Strong Sell → 0
 *
 * Treating "Buy" and "Strong Buy" identically (and same for the sell side)
 * matches how PMs typically use the consensus — the gradient is usually
 * already captured in the numeric rating.
 */
function bucketConsensus(c: BoostedAiConsensus): 0 | 1 | 2 {
  if (c === "strong-buy" || c === "buy") return 2;
  if (c === "hold") return 1;
  return 0; // sell, strong-sell
}

/**
 * BoostedAI numeric rating (0-5, decimals allowed) → 0-2 bucket.
 *   4.0 – 5.0 → 2
 *   2.5 – 3.99 → 1
 *   0.0 – 2.49 → 0
 */
function bucketRating(rating: number): 0 | 1 | 2 {
  if (rating >= 4) return 2;
  if (rating >= 2.5) return 1;
  return 0;
}

/**
 * Combined BoostedAI → aiRating mapping.
 *
 *   Both inputs present: floor((ratingBucket + consensusBucket) / 2).
 *     Conservative — a divergence (e.g. 4.5 rating but Hold consensus)
 *     drops to 1 instead of averaging to 1.5.
 *   Only rating present: rating bucket directly.
 *   Only consensus present: consensus bucket directly.
 *   Neither present: returns null (caller leaves aiRating unchanged).
 *
 * Returns:
 *   - integer 0/1/2 when mappable
 *   - null when nothing to map (caller should NOT overwrite the existing
 *     manual aiRating in this case)
 */
export function mapBoostedAiToAiRating(
  rating: number | null | undefined,
  consensus: BoostedAiConsensus | null | undefined,
): 0 | 1 | 2 | null {
  const haveRating = typeof rating === "number" && isFinite(rating);
  const haveConsensus = !!consensus;
  if (!haveRating && !haveConsensus) return null;

  const r = haveRating ? bucketRating(rating as number) : null;
  const c = haveConsensus ? bucketConsensus(consensus as BoostedAiConsensus) : null;
  if (r != null && c != null) {
    return Math.floor((r + c) / 2) as 0 | 1 | 2;
  }
  return (r ?? c) as 0 | 1 | 2;
}

/**
 * SIA SMAX (0-10 integer) → relativeStrength (0-2).
 *   SMAX 8-10 → 2  (SIA's "Favored Zone" — actionable on the long side)
 *   SMAX 6-7  → 1  (above average, watchlist-worthy)
 *   SMAX 0-5  → 0  (below SIA's actionable threshold)
 *
 * Returns null when SMAX is missing — caller should leave the existing
 * relativeStrength score untouched rather than wiping it to 0.
 */
export function mapSmaxToRelativeStrength(
  smax: number | null | undefined,
): 0 | 1 | 2 | null {
  if (typeof smax !== "number" || !isFinite(smax)) return null;
  if (smax >= 8) return 2;
  if (smax >= 6) return 1;
  return 0;
}

/**
 * Pretty label for a consensus value (UI display).
 */
export function consensusLabel(c: BoostedAiConsensus | null | undefined): string {
  if (!c) return "—";
  switch (c) {
    case "strong-buy": return "Strong Buy";
    case "buy": return "Buy";
    case "hold": return "Hold";
    case "sell": return "Sell";
    case "strong-sell": return "Strong Sell";
  }
}

/**
 * Tailwind class set for the consensus chip — color-coded by direction.
 */
export function consensusToneClass(c: BoostedAiConsensus | null | undefined): string {
  if (!c) return "bg-slate-50 text-slate-400 border-slate-200";
  if (c === "strong-buy") return "bg-emerald-600 text-white border-emerald-700";
  if (c === "buy") return "bg-emerald-100 text-emerald-700 border-emerald-200";
  if (c === "hold") return "bg-amber-100 text-amber-700 border-amber-200";
  if (c === "sell") return "bg-red-100 text-red-700 border-red-200";
  return "bg-red-600 text-white border-red-700"; // strong-sell
}
