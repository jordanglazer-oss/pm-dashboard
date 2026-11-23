/**
 * Scoring SHADOW (Nov 2026) — pure arithmetic, no I/O.
 *
 * The team found the conviction score biased toward large caps, especially US
 * names. This file recomputes the deterministic parts of the score with the
 * agreed fixes so the result can be read BESIDE the live score. Nothing here
 * is used by /api/score, and nothing here writes a score.
 *
 *   (a) Estimate revisions as a SHARE of the analyst panel, not a raw count —
 *       a stock with 40 analysts collects more "up" revisions than one with 8.
 *   (b) Research mentions measured against the lists a stock could be on — 9
 *       of the bullish lists are US-only and 5 are Canadian-only, and today a
 *       list you cannot be on scores the same as a list that passed on you.
 *   (c) A missing RBC / JPM report (or no street target) is NO DATA: the
 *       level part of analyst consensus is rescaled over what is on file
 *       instead of counting the gap as zero.
 *   (d) Returns & margins ranked against sector peers — app/lib/quality-score.
 *   (e) Thin coverage capping catalysts / relative valuation: there is no
 *       deterministic cap to recompute (see the route's `notComputed` note).
 */

import { SCORE_GROUPS, MAX_SCORE, type ScoreKey } from "./types";
import { RATING_WEIGHT, ratingScore, upsideScore, type TickerSnapshot } from "./analyst-snapshots";
import type { MentionDirection, MentionSource } from "./research-mentions";

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ── (a) revisions as a share of the panel ───────────────────────────────

/** Net revisions ÷ analysts at or above `full` → ±1; at or above `half` → ±0.5. Starting values. */
export const REVISION_SHARE = { full: 0.25, half: 0.1 };
/** A panel smaller than this can move the score by at most ±0.5: one or two
 *  analysts changing a number is not a corroborated move. */
export const REVISION_MIN_PANEL = 4;

export type ShadowRevision = { up: number; down: number; net: number; analysts: number | null; share: number | null; contribution: number; basis: "share of panel" | "raw count (no analyst count on file)" };

/** Today's rule, for the side-by-side: |net| ≥ 4 → ±1, ≥ 2 → ±0.5. */
export function currentRevisionContribution(net: number): number {
  return net >= 4 ? 1 : net >= 2 ? 0.5 : net <= -4 ? -1 : net <= -2 ? -0.5 : 0;
}

export function shadowRevision(up: number | undefined, down: number | undefined, analysts: number | undefined | null): ShadowRevision | null {
  if (typeof up !== "number" && typeof down !== "number") return null;
  const u = up ?? 0, d = down ?? 0, net = u - d;
  if (typeof analysts !== "number" || !(analysts > 0)) return { up: u, down: d, net, analysts: null, share: null, contribution: currentRevisionContribution(net), basis: "raw count (no analyst count on file)" };
  // Revisions can outnumber the estimate count (an analyst may revise twice): hold the share to ±1.
  const share = clamp(net / analysts, -1, 1);
  const mag = Math.abs(share) >= REVISION_SHARE.full ? 1 : Math.abs(share) >= REVISION_SHARE.half ? 0.5 : 0;
  const capped = analysts < REVISION_MIN_PANEL ? Math.min(mag, 0.5) : mag;
  return { up: u, down: d, net, analysts, share: r2(share), contribution: net === 0 ? 0 : Math.sign(net) * capped, basis: "share of panel" };
}

// ── (c) analyst consensus with gaps as "no data" ────────────────────────

/** The level part of analyst consensus tops out at this (two ratings + upside). */
export const LEVEL_MAX = RATING_WEIGHT * 3;

export type ShadowConsensus = {
  /** null → nothing on file at all: the category drops out of the composite. */
  score: number | null;
  level: { onFile: string[]; missing: string[]; earned: number; outOf: number; rescaled: number } | null;
  revisions: ShadowRevision | null;
  morningstar: number;
};

export function shadowAnalystConsensus(snapshot: TickerSnapshot | undefined, currentPrice: number | undefined): ShadowConsensus {
  const onFile: string[] = [], missing: string[] = [];
  let earned = 0, outOf = 0;
  for (const [name, entry] of [["RBC rating", snapshot?.rbc], ["JPM rating", snapshot?.jpm]] as const) {
    if (entry && entry.rating !== "not-covered") { onFile.push(name); earned += ratingScore(entry.rating); outOf += RATING_WEIGHT; }
    else missing.push(name);
  }
  const target = snapshot?.factset?.averageTarget;
  if (typeof target === "number" && target > 0 && typeof currentPrice === "number" && currentPrice > 0) { onFile.push("Street target"); earned += upsideScore(target, currentPrice); outOf += RATING_WEIGHT; }
  else missing.push("Street target");

  const revisions = shadowRevision(snapshot?.factset?.revUp, snapshot?.factset?.revDown, snapshot?.factset?.analystCount);
  const stars = snapshot?.morningstar?.stars;
  const morningstar = typeof stars !== "number" || stars < 1 || stars > 5 ? 0 : stars >= 5 ? 0.5 : stars >= 4 ? 0.25 : stars <= 1 ? -0.5 : stars <= 2 ? -0.25 : 0;

  // No rating and no target: revisions / stars are modifiers on a level that does not exist.
  if (outOf === 0) return { score: null, level: null, revisions, morningstar };
  const rescaled = (earned / outOf) * LEVEL_MAX;
  const score = clamp(r2(rescaled + (revisions?.contribution ?? 0) + morningstar), 0, 3);
  return { score, level: { onFile, missing, earned: r2(earned), outOf: r2(outOf), rescaled: r2(rescaled) }, revisions, morningstar };
}

// ── (b) research mentions vs the lists a stock could be on ──────────────

/** Which market each list covers. Read from the list's own name / publisher —
 *  NOT yet confirmed with the team list by list (see the route's assumptions). */
export const LIST_COUNTRY: Record<MentionSource, "US" | "CA"> = {
  upticks: "US",
  "fundstrat-top": "US",
  "fundstrat-bottom": "US",
  "fundstrat-smid-top": "US",
  "fundstrat-smid-bottom": "US",
  "rbc-focus": "CA",
  "rbc-us-focus": "US",
  "jpm-us-analyst-focus": "US",
  "rbc-equate-cad": "CA",
  "rbc-equate-usd": "US",
  "seeking-alpha-picks": "US",
  "rbccm-few": "CA",
  "veritas-vlist": "CA",
  "rbc-cad-smallcap": "CA",
  "fundstrat-lc-core-list": "US",
  "fundstrat-smid-core-list": "US",
};

export type ListDef = { source: MentionSource; direction: MentionDirection };
export type ShadowMentions = { score: number; bullishOn: number; bearishOn: number; eligibleBullish: number; referenceBullish: number; multiplier: number; eligibleLists: MentionSource[] };

/**
 * `country` is the stock's listing. A stock is eligible for every bullish list
 * covering its market, plus any other list it actually appears on (an
 * interlisted name on a US list). Each bullish mention counts
 * reference ÷ eligible, where reference is the largest single-market list
 * count — so a name in the best-covered market scores exactly as it does
 * today, and a name in a thinner market is not marked down for lists it could
 * never have been on. Bearish mentions count one each, as today.
 */
export function shadowResearchMentions(country: "US" | "CA", onSources: MentionSource[], lists: ListDef[]): ShadowMentions {
  const bullish = lists.filter((l) => l.direction === "bullish");
  const on = new Set(onSources);
  const eligible = bullish.filter((l) => LIST_COUNTRY[l.source] === country || on.has(l.source)).map((l) => l.source);
  const perMarket = (c: "US" | "CA") => bullish.filter((l) => LIST_COUNTRY[l.source] === c).length;
  const reference = Math.max(perMarket("US"), perMarket("CA"));
  const bullishOn = bullish.filter((l) => on.has(l.source)).length;
  const bearishOn = lists.filter((l) => l.direction === "bearish" && on.has(l.source)).length;
  const multiplier = eligible.length > 0 ? Math.max(1, reference / eligible.length) : 1;
  return { score: clamp(r2(bullishOn * multiplier - bearishOn), 0, 3), bullishOn, bearishOn, eligibleBullish: eligible.length, referenceBullish: reference, multiplier: r2(multiplier), eligibleLists: eligible };
}

// ── composite ───────────────────────────────────────────────────────────

export const CATEGORY_MAXES: Record<string, number> = Object.fromEntries(SCORE_GROUPS.flatMap((g) => g.categories.map((c) => [c.key, c.max])));
export const RUBRIC_KEYS = Object.keys(CATEGORY_MAXES) as ScoreKey[];

/** The live composite's own rule: sum the categories that apply, rescale to the 33-point scale, one decimal. */
export function compositeFrom(scores: Partial<Record<string, number>>, excluded: Iterable<string>): { composite: number; effectiveMax: number } {
  const out = new Set(excluded);
  let sum = 0, max = 0;
  for (const k of RUBRIC_KEYS) {
    if (out.has(k)) continue;
    sum += scores[k] || 0;
    max += CATEGORY_MAXES[k];
  }
  return { composite: max > 0 ? Math.round(sum * (MAX_SCORE / max) * 10) / 10 : 0, effectiveMax: max };
}

// ── summary ─────────────────────────────────────────────────────────────

export const SIZE_BUCKETS = ["Mega (≥ 200B)", "Large (10–200B)", "Mid (2–10B)", "Small (< 2B)", "Size unknown"] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];
/** `marketCapM` in millions, as stored on the stock record (its own trading currency). */
export function sizeBucket(marketCapM: number | null | undefined): SizeBucket {
  if (typeof marketCapM !== "number" || !(marketCapM > 0)) return "Size unknown";
  return marketCapM >= 200_000 ? "Mega (≥ 200B)" : marketCapM >= 10_000 ? "Large (10–200B)" : marketCapM >= 2_000 ? "Mid (2–10B)" : "Small (< 2B)";
}

export type ShiftRow = { label: string; names: number; avgCurrent: number; avgShadow: number; avgShift: number; up: number; down: number };
export function summarise<T extends { current: number; shadow: number }>(rows: T[], labelOf: (r: T) => string, order?: readonly string[]): ShiftRow[] {
  const groups = new Map<string, T[]>();
  for (const r of rows) groups.set(labelOf(r), [...(groups.get(labelOf(r)) ?? []), r]);
  const avg = (xs: number[]) => r2(xs.reduce((s, x) => s + x, 0) / xs.length);
  const out = [...groups].map(([label, rs]) => ({
    label, names: rs.length,
    avgCurrent: avg(rs.map((r) => r.current)), avgShadow: avg(rs.map((r) => r.shadow)), avgShift: avg(rs.map((r) => r.shadow - r.current)),
    up: rs.filter((r) => r.shadow - r.current > 0.05).length, down: rs.filter((r) => r.shadow - r.current < -0.05).length,
  }));
  return order ? out.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label)) : out.sort((a, b) => a.label.localeCompare(b.label));
}
