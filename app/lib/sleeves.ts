/* ─── Alpha sleeves: Thesis / Tactical ───
 *
 * Alpha holdings split into two sleeves:
 *   Thesis   — long-run holds, sold only when the thesis breaks.
 *   Tactical — shorter-horizon positions, reviewed the first Monday of each month.
 *
 * A STOCK can sit in both: a Thesis name carrying a temporary Tactical
 * overweight. A FUND / ETF sits in at most one — its weight is a single
 * manually-set number, so "both" has no meaning for it.
 *
 * The tags live on the Stock record in pm:stocks (`inThesis` / `inTactical`),
 * beside `designation`. They are TAGS ONLY today — nothing in the rebalance or
 * performance math reads them. Core-designated holdings have no sleeve; a tag
 * left on a holding that is later re-designated Core is ignored, not deleted.
 *
 * Pure helpers, client- and server-safe. New code should read sleeves through
 * here rather than re-deriving the "unset designation means Alpha" convention. */

export type AlphaSleeve = "thesis" | "tactical";

type SleeveFields = {
  designation?: "core" | "alpha";
  inThesis?: boolean;
  inTactical?: boolean;
  instrumentType?: string;
  name?: string;
  sector?: string;
};

/** Default-undefined designation means Alpha; only an explicit "core" is Core. */
export function isCoreDesignated(s: Pick<SleeveFields, "designation">): boolean {
  return s.designation === "core";
}

export function isFund(s: Pick<SleeveFields, "instrumentType">): boolean {
  return Boolean(s.instrumentType) && s.instrumentType !== "stock";
}

/** Bond / alternative funds are outside the equity Alpha segment entirely.
 *  Same name/sector heuristic the Portfolio-role control uses. */
export function isBondOrAltFund(s: Pick<SleeveFields, "name" | "sector">): boolean {
  const nl = (s.name || "").toLowerCase();
  const sl = (s.sector || "").toLowerCase();
  return sl.includes("bond") || sl.includes("fixed") || nl.includes("bond") || nl.includes("fixed income")
    || sl.includes("alternative") || nl.includes("alternative") || nl.includes("premium yield") || nl.includes("premium incom")
    || nl.includes("hedge") || nl.includes("option income") || nl.includes("option writing") || nl.includes("covered call");
}

/** Can this holding carry a Thesis/Tactical tag at all? Equity Alpha only. */
export function isSleeveTaggable(s: SleeveFields): boolean {
  if (isCoreDesignated(s)) return false;
  if (isFund(s) && isBondOrAltFund(s)) return false;
  return true;
}

export function sleevesOf(s: SleeveFields): { thesis: boolean; tactical: boolean } {
  if (!isSleeveTaggable(s)) return { thesis: false, tactical: false };
  const thesis = s.inThesis === true;
  // A fund holds one sleeve only; if a stored record somehow carries both, Thesis wins.
  const tactical = s.inTactical === true && !(isFund(s) && thesis);
  return { thesis, tactical };
}

/** Taggable but carrying neither tag — blocks sleeve weights from going live. */
export function isUntagged(s: SleeveFields): boolean {
  if (!isSleeveTaggable(s)) return false;
  const { thesis, tactical } = sleevesOf(s);
  return !thesis && !tactical;
}

export function sleeveLabel(s: SleeveFields): "Thesis" | "Tactical" | "Thesis + Tactical" | null {
  const { thesis, tactical } = sleevesOf(s);
  if (thesis && tactical) return "Thesis + Tactical";
  if (thesis) return "Thesis";
  if (tactical) return "Tactical";
  return null;
}

/** Fields to persist when the PM toggles one sleeve on a holding. Stocks toggle
 *  each sleeve independently; on a fund, turning one on turns the other off. */
export function toggleSleeveFields(s: SleeveFields, sleeve: AlphaSleeve): { inThesis: boolean; inTactical: boolean } {
  const cur = { inThesis: s.inThesis === true, inTactical: s.inTactical === true };
  const key = sleeve === "thesis" ? "inThesis" : "inTactical";
  const next = { ...cur, [key]: !cur[key] };
  if (isFund(s) && next[key]) {
    if (sleeve === "thesis") next.inTactical = false;
    else next.inThesis = false;
  }
  return next;
}

export type SleeveCounts = { thesis: number; tactical: number; both: number; untagged: number; taggable: number };

/** Name counts across a list of holdings (pass Portfolio holdings only). */
export function sleeveCounts(list: SleeveFields[]): SleeveCounts {
  const c: SleeveCounts = { thesis: 0, tactical: 0, both: 0, untagged: 0, taggable: 0 };
  for (const s of list) {
    if (!isSleeveTaggable(s)) continue;
    c.taggable++;
    const { thesis, tactical } = sleevesOf(s);
    if (thesis) c.thesis++;
    if (tactical) c.tactical++;
    if (thesis && tactical) c.both++;
    if (!thesis && !tactical) c.untagged++;
  }
  return c;
}
