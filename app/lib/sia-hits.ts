import type { SiaSnapshot } from "./sia-universe-shared";
import type { SourceHit } from "./watchlist-candidates";

/**
 * SIA universe snapshot → suggested-watchlist candidates.
 *
 * No parsing: the weekly S&P 500 / TSX 60 exports already land in
 * pm:sia-universe with rank, SMAX, sector and SIA's own rank change over each
 * window. This only decides which of those readings is worth surfacing.
 *
 * WHAT MAKES A CANDIDATE. Rank LEVEL alone is a poor filter — the top of the
 * SIA universe is largely the same names week after week, so it nominates
 * nothing new. The useful signal is rank IMPROVEMENT at a level that is
 * already respectable: a name climbing hard from 400th is noise, the same
 * climb into the top quartile is an idea. Both conditions are required.
 *
 * SIGN CONVENTION (documented in sia-universe-shared and confirmed against the
 * data): a POSITIVE change means the name CLIMBED that many places. Reading it
 * backwards would surface the week's worst deteriorations as buy ideas, and
 * would look entirely reasonable on screen.
 *
 * SMAX is deliberately not used as the gate. It is a 0-10 integer, so hundreds
 * of names tie at 8/9/10 — too coarse to separate a universe. It rides along
 * as context.
 *
 * BOTH GATES ARE RELATIVE TO THE NAME'S OWN INDEX. The S&P 500 and TSX files
 * merge into one snapshot, so an absolute threshold silently meant two
 * different things: "rank <= 150" was the top 30% of the S&P but the whole of
 * the 62-name TSX, and "climbed >= 20 places" was 4% of the S&P but a third of
 * the TSX — simultaneously far too loose on level and near-impossible on
 * movement for the Canadian names. Dividing by the block size each row came
 * from puts every name on the same footing.
 */

export type SiaHitOptions = {
  /** Minimum climb, as a PERCENT of the name's own index (4 = 4%). */
  minImprovementPct?: number;
  /** Only names inside this percentile of their own index (30 = top 30%). */
  maxRankPct?: number;
  /** Fall back to the monthly window when the weekly one is flat/missing. */
  useMonthly?: boolean;
  /** Universe size assumed for rows written before universeSize was stored.
   *  The old snapshot format has no way to tell the two indices apart, so a
   *  stale snapshot keeps behaving exactly as it did until the next upload. */
  legacyUniverseSize?: number;
};

export function siaHits(snapshot: SiaSnapshot | null, opts?: SiaHitOptions): SourceHit[] {
  if (!snapshot?.rows) return [];
  // Both gates are percentages OF THE NAME'S OWN INDEX. The defaults are the
  // old absolute thresholds re-expressed against the S&P 500 (150/504 ≈ 30%,
  // 20/504 ≈ 4%), so that index is left as it was to within one name at the
  // rank boundary — 30% of 504 rounds to 151, not 150. It is the TSX that was
  // being judged on a different scale and is materially corrected.
  const minImprovePct = opts?.minImprovementPct ?? 4;
  const maxRankPct = opts?.maxRankPct ?? 30;
  const useMonthly = opts?.useMonthly ?? true;
  const legacyN = opts?.legacyUniverseSize ?? 504;

  const out: SourceHit[] = [];
  for (const [ticker, r] of Object.entries(snapshot.rows)) {
    if (r.rank == null) continue;
    // Rows written before universeSize existed fall back to the S&P size,
    // which reproduces the previous thresholds exactly.
    const N = r.universeSize && r.universeSize > 0 ? r.universeSize : legacyN;
    // Rounded to whole names so the gate is a rank you can state ("top 151 of
    // the S&P, top 19 of the TSX") rather than a float comparison.
    const maxRank = Math.max(1, Math.round((maxRankPct / 100) * N));
    const minImprove = Math.max(1, Math.round((minImprovePct / 100) * N));
    if (r.rank > maxRank) continue;
    const weekly = r.wChg ?? 0;
    const monthly = r.mChg ?? 0;
    const climb = useMonthly ? Math.max(weekly, monthly) : weekly;
    if (climb < minImprove) continue;
    out.push({
      ticker,
      source: "sia",
      sector: r.sector ?? undefined,
      rank: r.rank,
      // A big climb INTO the top of the universe is a conviction reading, not
      // just presence on a list.
      signal: (100 * r.rank) / N <= 5 && climb >= minImprove * 2 ? "strong-buy" : "buy",
      // How FAR it climbed, graduated rather than binary: 100+ places is a
      // full-strength reading, and the engine caps its contribution so a
      // dramatic mover cannot outrank genuine multi-source confluence.
      // Scaled by the index it moved within, so climbing a fifth of the TSX
      // and a fifth of the S&P read as the same strength of move.
      magnitude: Math.min(1, climb / (0.2 * N)),
    });
  }
  // Best rank first, so the cutoff below is applied to the strongest names.
  return out.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
}
