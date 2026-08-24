/**
 * Pure-display helpers for the researchMentions category. Kept in its
 * own file (no Redis / Node imports) so client components can import
 * the explanation builder without pulling the `redis` package into the
 * browser bundle.
 *
 * The tally itself lives in research-mentions.ts because it has to read
 * Redis caches; that file is server-only. Anything client-side that
 * needs to render the result imports from THIS file instead.
 */

export type MentionDirection = "bullish" | "bearish";

export type DisplayMention = {
  label: string;
  direction: MentionDirection;
  /** ISO timestamp the cache entry was analyzed at. */
  analyzedAt?: string;
};

export type DisplayMentionResult = {
  score: number;
  rawDelta: number;
  mentions: DisplayMention[];
};

/**
 * Build the per-category explanation block (summary + dataPoints) for
 * researchMentions. Mirrors the logic inlined in /api/score/route.ts
 * so the client can render the same structure when it recomputes
 * mentions live (post-scrape, on bootstrap) without making a full
 * Anthropic call.
 */
export function buildResearchMentionsExplanation(
  ticker: string,
  result: DisplayMentionResult,
): {
  summary: string;
  dataPoints: Array<{ label: string; value: string; source: "model"; sourceDetail?: string }>;
} {
  const upper = ticker.toUpperCase();
  const bullishCount = result.mentions.filter((m) => m.direction === "bullish").length;
  const bearishCount = result.mentions.filter((m) => m.direction === "bearish").length;
  const summary =
    result.mentions.length === 0
      ? `No mentions of ${upper} found across cached research feeds. Score: ${result.score}/3.`
      : `Tallied ${result.mentions.length} mention${result.mentions.length === 1 ? "" : "s"} across cached research feeds (${bullishCount} bullish, ${bearishCount} bearish). Raw delta: ${result.rawDelta >= 0 ? "+" : ""}${result.rawDelta}, clamped to ${result.score}/3.`;
  const dataPoints = result.mentions.map((m) => ({
    label: m.label,
    value: m.direction === "bullish" ? "Bullish (+1)" : "Bearish (−1)",
    source: "model" as const,
    sourceDetail: m.analyzedAt ? `Analyzed ${m.analyzedAt.slice(0, 10)}` : undefined,
  }));
  return { summary, dataPoints };
}
