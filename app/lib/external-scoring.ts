/**
 * Maps raw external-tool scores (BoostedAI rating + consensus, SIA SMAX)
 * into the dashboard's internal scoring categories (aiRating, relativeStrength).
 *
 * BoostedAI rating uses linear interpolation (0-5 → 0-2). Consensus uses a
 * signed scale: Strong Buy=2, Buy=1.5, Hold=0, Sell=−1, Strong Sell=−1.5.
 * Hold is NEUTRAL (0 pts) — bearish consensus actively penalizes the score.
 * When both rating and consensus are present, aiRating is their average,
 * which CAN go negative (e.g. rating 1.0 + Strong Sell = (0.4 + −1.5)/2 = −0.55).
 *
 * SIA uses a tiered mapping that respects the Favored Zone threshold at
 * SMAX 8, with half-step granularity within zones.
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
 * BoostedAI consensus → signed score.
 *   Strong Buy  →  2.0   (most bullish)
 *   Buy         →  1.5
 *   Hold        →  0.0   (neutral — no contribution)
 *   Sell        → −1.0
 *   Strong Sell → −1.5   (most bearish)
 *
 * Hold at 0 means "no signal" — a stock with no consensus entered and a
 * stock with Hold consensus contribute the same to the composite. Bearish
 * consensus actively drags the score down, differentiating "we don't know"
 * from "analysts say sell."
 */
function consensusScore(c: BoostedAiConsensus): number {
  switch (c) {
    case "strong-buy": return 2;
    case "buy": return 1.5;
    case "hold": return 0;
    case "sell": return -1;
    case "strong-sell": return -1.5;
  }
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
 * Combined BoostedAI → aiRating mapping (fractional, can go negative).
 *
 *   Both inputs present: average of linearRating + consensusScore.
 *     e.g. rating 4.5 + Buy   = (1.8 + 1.5) / 2 =  1.65
 *     e.g. rating 3.0 + Sell  = (1.2 + −1)  / 2 =  0.10
 *     e.g. rating 1.0 + S.Sell = (0.4 + −1.5)/ 2 = −0.55
 *   Only rating present: linearRating directly.
 *   Only consensus present: consensusScore directly.
 *   Neither present: returns null (caller leaves aiRating unchanged).
 *
 * Returns:
 *   - number (fractional, may be negative) when mappable
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
  const c = haveConsensus ? consensusScore(consensus as BoostedAiConsensus) : null;
  if (r != null && c != null) {
    return Math.round(((r + c) / 2) * 100) / 100;
  }
  return (r ?? c) as number;
}

/**
 * SIA SMAX (0-10) → relativeStrength (tiered 0-2).
 *
 * Respects SIA's zone thresholds rather than using a smooth linear ramp:
 *   SMAX 10 → 2.0   (top of Favored Zone)
 *   SMAX  9 → 1.8   (strong Favored)
 *   SMAX  8 → 1.6   (entry to Favored Zone — key threshold)
 *   SMAX  7 → 1.2   (upper transition)
 *   SMAX  6 → 0.8   (lower transition)
 *   SMAX  5 → 0.4   (mid yellow / neutral zone)
 *   SMAX 0-4 → 0.0  (Unfavored Zone — no contribution)
 *
 * Returns null when SMAX is missing — caller should leave the existing
 * relativeStrength score untouched rather than wiping it to 0.
 */
export function mapSmaxToRelativeStrength(
  smax: number | null | undefined,
): number | null {
  if (typeof smax !== "number" || !isFinite(smax)) return null;
  const clamped = Math.max(0, Math.min(10, Math.round(smax)));
  const tiers: Record<number, number> = {
    10: 2.0, 9: 1.8, 8: 1.6,
    7: 1.2, 6: 0.8,
    5: 0.4,
    4: 0, 3: 0, 2: 0, 1: 0, 0: 0,
  };
  return tiers[clamped] ?? 0;
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
