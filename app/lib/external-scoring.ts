/**
 * Maps raw external-tool scores (BoostedAI rating + consensus, SIA SMAX)
 * into the dashboard's internal 0-2 scoring categories (aiRating,
 * relativeStrength).
 *
 * Both mappings use LINEAR INTERPOLATION to preserve full fractional
 * precision — e.g. a BoostedAI 4.5 maps to 1.8/2 rather than bucketing
 * to an integer. The consensus is categorical so it stays as a 0/1/2
 * bucket; when both rating and consensus are present, the final aiRating
 * is their average (no floor).
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
 * BoostedAI consensus → 0-2 bucket (categorical, no gradient).
 *   Strong Buy / Buy → 2
 *   Hold            → 1
 *   Sell / Strong Sell → 0
 */
function consensusBucket(c: BoostedAiConsensus): 0 | 1 | 2 {
  if (c === "strong-buy" || c === "buy") return 2;
  if (c === "hold") return 1;
  return 0; // sell, strong-sell
}

/**
 * BoostedAI numeric rating (0-5) → linear 0-2 scale.
 *   rating × 0.4, clamped to [0, 2].
 *   Examples: 5→2.0, 4.5→1.8, 3.2→1.28, 2.5→1.0, 1→0.4, 0→0
 */
function linearRating(rating: number): number {
  return Math.max(0, Math.min(2, Math.round(rating * 0.4 * 100) / 100));
}

/**
 * Combined BoostedAI → aiRating mapping (fractional 0-2).
 *
 *   Both inputs present: average of linearRating + consensusBucket.
 *     e.g. rating 4.5 + Buy = (1.8 + 2) / 2 = 1.9
 *   Only rating present: linearRating directly.
 *   Only consensus present: consensus bucket directly.
 *   Neither present: returns null (caller leaves aiRating unchanged).
 *
 * Returns:
 *   - number in [0, 2] (fractional) when mappable
 *   - null when nothing to map
 */
export function mapBoostedAiToAiRating(
  rating: number | null | undefined,
  consensus: BoostedAiConsensus | null | undefined,
): number | null {
  const haveRating = typeof rating === "number" && isFinite(rating);
  const haveConsensus = !!consensus;
  if (!haveRating && !haveConsensus) return null;

  const r = haveRating ? linearRating(rating as number) : null;
  const c = haveConsensus ? consensusBucket(consensus as BoostedAiConsensus) : null;
  if (r != null && c != null) {
    return Math.round(((r + c) / 2) * 100) / 100;
  }
  return (r ?? c) as number;
}

/**
 * SIA SMAX (0-10) → relativeStrength (linear 0-2).
 *   smax × 0.2, clamped to [0, 2].
 *   Examples: 10→2.0, 8→1.6, 7→1.4, 5→1.0, 3→0.6, 0→0
 *
 * Returns null when SMAX is missing — caller should leave the existing
 * relativeStrength score untouched rather than wiping it to 0.
 */
export function mapSmaxToRelativeStrength(
  smax: number | null | undefined,
): number | null {
  if (typeof smax !== "number" || !isFinite(smax)) return null;
  return Math.max(0, Math.min(2, Math.round(smax * 0.2 * 100) / 100));
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
