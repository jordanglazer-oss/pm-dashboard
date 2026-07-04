/**
 * Idea pipeline — turns the research-driven idea feed into a tracked FUNNEL
 * instead of an ephemeral list. Every name that appears on a research list gets
 * "surfaced" (captured with its first-surfaced date, the price at that moment,
 * and which lists carried it), then the PM moves it through a status
 * (new → watching → bought / passed). Performance-since-surfaced closes the loop:
 * you can see whether the ideas your sources feed actually work.
 *
 * Persisted at Redis `pm:idea-pipeline` = { [normalizedTicker]: entry }. The
 * route merges rather than overwrites, and never drops firstSurfaced /
 * priceAtSurface, so the original surfacing point is immutable once set.
 */

export type IdeaStatus = "new" | "watching" | "bought" | "passed";

export type IdeaPipelineEntry = {
  /** Display ticker (as surfaced). */
  ticker: string;
  /** Date the idea first appeared on a research list ("YYYY-MM-DD"). */
  firstSurfaced: string;
  /** Price at first surfacing — the basis for performance-since. */
  priceAtSurface?: number;
  status: IdeaStatus;
  /** Research-list labels that carried it at surfacing. */
  sources: string[];
  updatedAt: string;
};

export type IdeaPipelineStore = Record<string, IdeaPipelineEntry>;

export const IDEA_PIPELINE_KEY = "pm:idea-pipeline";

/** Normalize a ticker for the pipeline key (matches conviction.ts / research-merge.ts). */
export function ideaKey(ticker: string): string {
  return String(ticker || "").replace(/^\$+/, "").replace(/\//g, "-").split(/[.\s]/)[0].toUpperCase();
}

export const IDEA_STATUS_LABELS: Record<IdeaStatus, string> = {
  new: "New",
  watching: "Watching",
  bought: "Owned",
  passed: "Passed",
};
