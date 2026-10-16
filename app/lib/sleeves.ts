/* ─── Holding-role helpers ───
 *
 * Small, pure, client- and server-safe helpers about a holding's role. The
 * Thesis / Tactical alpha-sleeve tags that used to live here were retired in
 * Oct 2026 in favour of the three-bucket model (Core / Thematic / Alpha,
 * app/lib/sleeve-targets.ts). The `inThesis` / `inTactical` fields may still
 * sit on old pm:stocks records; nothing reads them. */

type SleeveFields = {
  designation?: "core" | "alpha" | "thematic";
  instrumentType?: string;
  name?: string;
  sector?: string;
};

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
    || (nl.includes("hedge") && !nl.includes("hedged")) || nl.includes("option income") || nl.includes("option writing") || nl.includes("covered call");
}
