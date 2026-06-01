/**
 * Deterministic tally for the `researchMentions` score category. Reads
 * every cached research-scrape blob (Newton Upticks + Fundstrat top/bottom
 * + RBC focus lists + Seeking Alpha picks), matches by canonical ticker,
 * and returns:
 *   - score: clamped to [0, 3], +1 per bullish source mention, −1 per bearish
 *   - mentions: per-source citation list for the "Show" panel
 *   - sourcesFresh / sourcesStale: counts for the confidence calculation
 *   - confidence: "high" / "medium" / "low" based on freshness of the
 *     underlying scrape caches (NOT shown in the UI per the rule that
 *     deterministic categories don't render a confidence chip; included
 *     here so the score route or future audit views can use it).
 *
 * Source weighting is intentionally uniform across all eight feeds — if
 * one source proves materially more/less predictive over time, weight it
 * in SOURCE_WEIGHTS rather than rebuilding the tally pipeline.
 */

import { getRedis } from "./redis";
import { canonicalTicker, tickersEqual } from "./ticker";

export type MentionDirection = "bullish" | "bearish";

export type MentionSource =
  | "upticks"
  | "fundstrat-top"
  | "fundstrat-bottom"
  | "fundstrat-smid-top"
  | "fundstrat-smid-bottom"
  | "rbc-focus"
  | "rbc-us-focus"
  | "seeking-alpha-picks"
  | "rbccm-few";

export type Mention = {
  source: MentionSource;
  label: string;
  direction: MentionDirection;
  /** ISO timestamp the cache entry was analyzed at (Newton Upticks / scrape route). */
  analyzedAt?: string;
};

export type ResearchMentionsResult = {
  /** Composite score, clamped to [0, 3]. Pre-clamp signed delta available via `rawDelta`. */
  score: number;
  /** Sum of bullish (+1) and bearish (−1) source contributions, pre-clamp. */
  rawDelta: number;
  mentions: Mention[];
  /** Confidence label derived from cache freshness (informational only). */
  confidence: "high" | "medium" | "low";
};

type SourceConfig = {
  source: MentionSource;
  label: string;
  /** Field name on the pm:research blob whose entry list this source maps to. */
  field: string;
  direction: MentionDirection;
};

// Sources now map to the LISTS on the pm:research blob — the same merged,
// curated lists shown on the Research page — rather than the raw AI-parse
// scrape caches (pm:research-scrape-cache:*). This makes the tally WYSIWYG:
// if a ticker is on the list the PM sees, it counts. Previously the tally
// read the scrape caches, which diverge from pm:research whenever an entry
// is manually added, merged, or survives across re-scrapes — that's why a
// name visibly on "Fundstrat Top Ideas" could still score 0/3.
//
// pm:research is a superset of any single scrape cache (scrape entries are
// merged INTO it), so reading it is strictly fuller coverage.
const SOURCES: SourceConfig[] = [
  { source: "upticks", label: "Newton Upticks", field: "newtonUpticks", direction: "bullish" },
  { source: "fundstrat-top", label: "Fundstrat Top Ideas", field: "fundstratTop", direction: "bullish" },
  { source: "fundstrat-bottom", label: "Fundstrat Bottom Ideas", field: "fundstratBottom", direction: "bearish" },
  { source: "fundstrat-smid-top", label: "Fundstrat SMID Top", field: "fundstratSmidTop", direction: "bullish" },
  { source: "fundstrat-smid-bottom", label: "Fundstrat SMID Bottom", field: "fundstratSmidBottom", direction: "bearish" },
  { source: "rbc-focus", label: "RBC Canadian Focus", field: "rbcCanadianFocus", direction: "bullish" },
  { source: "rbc-us-focus", label: "RBC US Focus", field: "rbcUsFocus", direction: "bullish" },
  { source: "seeking-alpha-picks", label: "Seeking Alpha Picks", field: "alphaPicks", direction: "bullish" },
  { source: "rbccm-few", label: "RBCCM Canadian FEW", field: "rbccmFew", direction: "bullish" },
];

type ResearchListEntry = { ticker?: unknown; analyzedAt?: unknown; dateAdded?: unknown };

export async function tallyResearchMentions(ticker: string): Promise<ResearchMentionsResult> {
  if (!ticker) return { score: 0, rawDelta: 0, mentions: [], confidence: "low" };
  const target = canonicalTicker(ticker);

  // Read the merged research state once (the same blob the Research page
  // displays). One Redis read instead of eight cache reads.
  let research: Record<string, unknown> | null = null;
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:research");
    if (raw) research = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    research = null;
  }
  if (!research) return { score: 0, rawDelta: 0, mentions: [], confidence: "low" };

  const mentions: Mention[] = [];
  let rawDelta = 0;

  for (const cfg of SOURCES) {
    const list = research[cfg.field];
    if (!Array.isArray(list)) continue;
    const hit = (list as ResearchListEntry[]).find((e) => {
      const t = typeof e?.ticker === "string" ? e.ticker : "";
      return t && tickersEqual(t, target);
    });
    if (!hit) continue;

    mentions.push({
      source: cfg.source,
      label: cfg.label,
      direction: cfg.direction,
      // Per-entry date if present (dateAdded on idea/RBC entries, analyzedAt
      // on upticks); informational only.
      analyzedAt:
        typeof hit.analyzedAt === "string"
          ? hit.analyzedAt
          : typeof hit.dateAdded === "string"
            ? hit.dateAdded
            : undefined,
    });
    rawDelta += cfg.direction === "bullish" ? 1 : -1;
  }

  const score = Math.max(0, Math.min(3, rawDelta));
  // Confidence is informational-only (not rendered in the UI per the rule
  // that deterministic categories don't show a confidence chip). With
  // pm:research as the source we no longer track per-cache freshness, so
  // report "high" when any mention exists, "low" otherwise. Kept for the
  // return-shape contract used by the score route / audit views.
  const confidence: "high" | "medium" | "low" = mentions.length > 0 ? "high" : "low";

  return { score, rawDelta, mentions, confidence };
}

// Pure-display helpers live in `research-mentions-display.ts` so client
// components can import them without pulling the `redis` package into
// the browser bundle. Re-exported here so the score route's
// server-side code can still import everything from one place.
export { buildResearchMentionsExplanation } from "./research-mentions-display";
