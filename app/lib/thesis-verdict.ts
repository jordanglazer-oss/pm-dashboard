/* ─── Thesis verdict: the name-level read of a Thesis-sleeve holding ───
 *
 * A Thesis name is judged on its THESIS, never on price. The post-earnings
 * review (app/lib/thesis-review) already reads each pillar against new
 * evidence as confirmed / contested / broken; this rolls those up into the
 * one word the monthly meeting works from:
 *
 *   intact      every pillar confirmed (or not yet readable)
 *   challenged  at least one pillar contested — open a review
 *   broken      at least one pillar broken — the only exit trigger
 *
 * Pure, client- and server-safe. */

export type PillarRead = { pillarId: string; title: string; status: "confirmed" | "contested" | "broken" | "unknown"; reading?: string };
export type ThesisVerdict = "intact" | "challenged" | "broken";

export const THESIS_VERDICT_LABEL: Record<ThesisVerdict, string> = {
  intact: "Thesis intact",
  challenged: "Thesis challenged",
  broken: "Thesis broken",
};

/** null when there are no pillars to read — no verdict is better than a fabricated "intact". */
export function thesisVerdictOf(pillars: PillarRead[] | undefined | null): ThesisVerdict | null {
  if (!pillars || pillars.length === 0) return null;
  if (pillars.some((p) => p.status === "broken")) return "broken";
  if (pillars.some((p) => p.status === "contested")) return "challenged";
  return "intact";
}

/** One row of pm:thesis-verdict-log. */
export type VerdictLogRow = {
  date: string; // YYYY-MM-DD (server UTC)
  generatedAt: string;
  evidenceAt: string | null;
  verdict: ThesisVerdict | null;
  pillars: Array<{ pillarId: string; title: string; status: PillarRead["status"] }>;
  summary: string;
};
export type VerdictLog = Record<string, VerdictLogRow[]>;
export const VERDICT_LOG_KEY = "pm:thesis-verdict-log";
export const VERDICT_LOG_MAX_PER_TICKER = 60;
