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
  | "seeking-alpha-picks";

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
  cacheKey: string;
  direction: MentionDirection;
};

const SOURCES: SourceConfig[] = [
  { source: "upticks", label: "Newton Upticks", cacheKey: "pm:upticks-scrape-cache", direction: "bullish" },
  { source: "fundstrat-top", label: "Fundstrat Top Ideas", cacheKey: "pm:research-scrape-cache:fundstrat-top", direction: "bullish" },
  { source: "fundstrat-bottom", label: "Fundstrat Bottom Ideas", cacheKey: "pm:research-scrape-cache:fundstrat-bottom", direction: "bearish" },
  { source: "fundstrat-smid-top", label: "Fundstrat SMID Top", cacheKey: "pm:research-scrape-cache:fundstrat-smid-top", direction: "bullish" },
  { source: "fundstrat-smid-bottom", label: "Fundstrat SMID Bottom", cacheKey: "pm:research-scrape-cache:fundstrat-smid-bottom", direction: "bearish" },
  { source: "rbc-focus", label: "RBC Canadian Focus", cacheKey: "pm:research-scrape-cache:rbc-focus", direction: "bullish" },
  { source: "rbc-us-focus", label: "RBC US Focus", cacheKey: "pm:research-scrape-cache:rbc-us-focus", direction: "bullish" },
  { source: "seeking-alpha-picks", label: "Seeking Alpha Picks", cacheKey: "pm:research-scrape-cache:seeking-alpha-picks", direction: "bullish" },
];

type CachedScrape = {
  hash: string;
  entries: Array<{ ticker?: unknown }>;
  analyzedAt: string;
};

async function readCache(cacheKey: string): Promise<CachedScrape | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get(cacheKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedScrape;
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const FRESH_WINDOW_DAYS = 14;
const STALE_WINDOW_DAYS = 30;

function daysSince(iso: string | undefined): number {
  if (!iso) return Infinity;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Infinity;
  return (Date.now() - t) / (1000 * 60 * 60 * 24);
}

export async function tallyResearchMentions(ticker: string): Promise<ResearchMentionsResult> {
  if (!ticker) return { score: 0, rawDelta: 0, mentions: [], confidence: "low" };
  const target = canonicalTicker(ticker);

  const cacheResults = await Promise.all(
    SOURCES.map(async (cfg) => ({ cfg, cache: await readCache(cfg.cacheKey) }))
  );

  const mentions: Mention[] = [];
  let rawDelta = 0;
  let freshSources = 0;
  let staleSources = 0;
  let anySource = 0;

  for (const { cfg, cache } of cacheResults) {
    if (!cache) continue;
    anySource += 1;
    const ageDays = daysSince(cache.analyzedAt);
    if (ageDays <= FRESH_WINDOW_DAYS) freshSources += 1;
    else if (ageDays > STALE_WINDOW_DAYS) staleSources += 1;

    const hit = cache.entries.find((e) => {
      const t = typeof e?.ticker === "string" ? e.ticker : "";
      return t && tickersEqual(t, target);
    });
    if (!hit) continue;

    mentions.push({
      source: cfg.source,
      label: cfg.label,
      direction: cfg.direction,
      analyzedAt: cache.analyzedAt,
    });
    rawDelta += cfg.direction === "bullish" ? 1 : -1;
  }

  const score = Math.max(0, Math.min(3, rawDelta));

  let confidence: "high" | "medium" | "low";
  if (anySource === 0) confidence = "low";
  else if (freshSources >= 3) confidence = "high";
  else if (staleSources === anySource) confidence = "low";
  else confidence = "medium";

  return { score, rawDelta, mentions, confidence };
}

/**
 * Build the per-category explanation block (summary + dataPoints) for
 * researchMentions. Mirrors the logic inlined in /api/score/route.ts
 * so the client can render the same structure when it recomputes
 * mentions live (post-scrape, on bootstrap, etc.) without making a
 * full Anthropic call.
 */
export function buildResearchMentionsExplanation(
  ticker: string,
  result: ResearchMentionsResult,
): { summary: string; dataPoints: Array<{ label: string; value: string; source: "model"; sourceDetail?: string }> } {
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
