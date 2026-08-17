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
 */

export type SiaHitOptions = {
  /** Minimum places climbed over the week. */
  minWeeklyImprovement?: number;
  /** Only names already inside this rank. */
  maxRank?: number;
  /** Fall back to the monthly window when the weekly one is flat/missing. */
  useMonthly?: boolean;
};

export function siaHits(snapshot: SiaSnapshot | null, opts?: SiaHitOptions): SourceHit[] {
  if (!snapshot?.rows) return [];
  const minImprove = opts?.minWeeklyImprovement ?? 20;
  const maxRank = opts?.maxRank ?? 150;
  const useMonthly = opts?.useMonthly ?? true;

  const out: SourceHit[] = [];
  for (const [ticker, r] of Object.entries(snapshot.rows)) {
    if (r.rank == null || r.rank > maxRank) continue;
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
      signal: r.rank <= 25 && climb >= minImprove * 2 ? "strong-buy" : "buy",
      // How FAR it climbed, graduated rather than binary: 100+ places is a
      // full-strength reading, and the engine caps its contribution so a
      // dramatic mover cannot outrank genuine multi-source confluence.
      magnitude: Math.min(1, climb / 100),
    });
  }
  // Best rank first, so the cutoff below is applied to the strongest names.
  return out.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));
}
