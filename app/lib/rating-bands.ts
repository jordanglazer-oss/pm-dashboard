/**
 * The ONE place the composite score's rating cutoffs live.
 *
 * Before this module the same four numbers (30 / 26 / 22 / 18) were typed
 * out in six files — computeScores, the change monitor, the calibration
 * buckets, the conviction board, the stock-page gauge and the Research
 * sources legend. Rubric v3 re-bases the composite (technicals leave the
 * 41-pt score, so the max changes) and the cutoffs will be RECALIBRATED
 * from score history rather than scaled by ratio. Every consumer must read
 * them from here so that recalibration is a one-line change.
 *
 * Behaviour is bit-for-bit identical to the inlined literals it replaces:
 *   label:  Strong Buy ≥ strongBuy, Moderate Buy ≥ moderateBuy, Hold ≥ hold,
 *           Underweight ≥ underweight, else Sell
 *   tier:   Buy ≥ strongBuy, Sell ≤ underweight, else Hold
 * Note the deliberate quirk: at EXACTLY `underweight` the tier is Sell but
 * the label is Underweight. That is how computeScores has always behaved
 * and the change monitor's Buy/Hold/Sell tier-flip events depend on it, so
 * it is preserved here rather than "fixed".
 */

export type RatingTier = "Buy" | "Hold" | "Sell";
export type RatingLabel = "Strong Buy" | "Moderate Buy" | "Hold" | "Underweight" | "Sell";

export type RatingBands = {
  /** ≥ this → Strong Buy (and tier Buy). */
  strongBuy: number;
  /** ≥ this → Moderate Buy. */
  moderateBuy: number;
  /** ≥ this → Hold. */
  hold: number;
  /** ≥ this → Underweight; ≤ this → tier Sell; below → label Sell. */
  underweight: number;
};

/**
 * Cutoffs on the 33-pt conviction composite (`MAX_SCORE` in types.ts).
 *
 * Rubric v3 recalibration (2026-09-12, /api/admin/rubric-v3-calibration on
 * 61 live book names): the old 30/26/22/18 on 41 were QUANTILE-matched onto
 * the 31-pt conviction subtotal (25 / 22 / 18.5 / 15 → fractions .806 /
 * .71 / .597 / .484, keeping 75% of labels; ratio-scaling kept only 36%),
 * then carried to 33 as fractions. Re-run the calibration once
 * returnsMargins has been scored across the book and adjust here if the
 * distribution has shifted. Legacy 41-pt values: 30 / 26 / 22 / 18.
 */
export const RATING_BANDS: RatingBands = {
  strongBuy: 26.5,
  moderateBuy: 23.5,
  hold: 19.5,
  underweight: 16,
};

/** The pre-v3 cutoffs on the 41-pt scale — for reading history entries
 *  stamped `scaleMax: 41` (or unstamped). */
export const LEGACY_41_BANDS: RatingBands = { strongBuy: 30, moderateBuy: 26, hold: 22, underweight: 18 };

export function ratingLabelFor(adjusted: number, bands: RatingBands = RATING_BANDS): RatingLabel {
  if (adjusted >= bands.strongBuy) return "Strong Buy";
  if (adjusted >= bands.moderateBuy) return "Moderate Buy";
  if (adjusted >= bands.hold) return "Hold";
  if (adjusted >= bands.underweight) return "Underweight";
  return "Sell";
}

export function ratingTierFor(adjusted: number, bands: RatingBands = RATING_BANDS): RatingTier {
  if (adjusted >= bands.strongBuy) return "Buy";
  if (adjusted <= bands.underweight) return "Sell";
  return "Hold";
}

/**
 * Colour tone for a score, as the stock-page gauge has always drawn it:
 * green from Moderate Buy up, amber through Hold, red below.
 */
export function ratingToneFor(adjusted: number, bands: RatingBands = RATING_BANDS): "pos" | "warn" | "neg" {
  if (adjusted >= bands.moderateBuy) return "pos";
  if (adjusted >= bands.hold) return "warn";
  return "neg";
}
