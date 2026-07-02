/**
 * Change-monitor engine — pure functions that diff the dashboard's stored
 * state into a typed list of "what changed" events for the Dashboard monitor.
 *
 * Design for "translates the data + adjusts over time":
 *  - Rating / score / category moves come from `pm:score-history`, an
 *    append-only per-ticker log. We compare the latest entry to the entry
 *    that was current when the window opened — so as the log grows, the
 *    window naturally slides forward. No fixed/seeded numbers.
 *  - Analyst-target updates come from `pm:analyst-snapshots` (a source's
 *    `lastUpdated`/`asOf` falling inside the window).
 *  - Price moves diff the live price against a rolling weekly baseline the
 *    route maintains (`pm:change-monitor-pricebase`).
 *  - Signal-divergence and data-staleness are CURRENT conditions read off the
 *    live stock, not window deltas — flagged whenever true.
 *
 * Everything is derived from data already persisted, so it stays correct as
 * the underlying numbers change. Thresholds are constants here so they're
 * easy to tune.
 */

import type { Stock, Scores, ScoreKey } from "./types";
import type { ScoreHistoryEntry, ScoreHistoryStore } from "@/app/api/kv/score-history/route";
import type { AnalystSnapshots } from "./analyst-snapshots";
import type { ResearchRemovalStore } from "./research-removals";
import { isScoreable, marketEdgeApplies } from "./scoring";

// ── Tunable thresholds ──────────────────────────────────────────────
export const THRESHOLDS = {
  /** Min absolute composite (adjusted) move to surface a "score" event. */
  compositeMove: 2,
  /** Min absolute weekly price move (%) to surface a "price" event. */
  priceMovePct: 7,
  /** A source value not refreshed in this many days reads as "going stale". */
  staleDays: 21,
};

export type ChangeType = "rating" | "score" | "target" | "price" | "signal" | "data" | "research-removed";
export type Severity = "up" | "down" | "warn" | "info";

export type ChangeEvent = {
  /** Stable id so a "reviewed" mark survives reloads (and re-fires only when
   *  the underlying fact changes). */
  id: string;
  ticker: string;
  name?: string;
  bucket?: "Portfolio" | "Watchlist";
  type: ChangeType;
  severity: Severity;
  headline: string;
  detail: string;
  delta?: string;
  /** ISO date the change is anchored to — used for sort + window labelling. */
  at: string;
};

// Rating thresholds mirror computeScores (Buy ≥ 30, Sell ≤ 18 on the 41 scale).
function ratingTier(adjusted: number): "Buy" | "Hold" | "Sell" {
  if (adjusted >= 30) return "Buy";
  if (adjusted <= 18) return "Sell";
  return "Hold";
}
function ratingLabel(adjusted: number): string {
  if (adjusted >= 30) return "Strong Buy";
  if (adjusted >= 26) return "Moderate Buy";
  if (adjusted >= 22) return "Hold";
  if (adjusted >= 18) return "Underweight";
  return "Sell";
}

const CATEGORY_LABELS: Partial<Record<ScoreKey, string>> = {
  marketEdge: "MarketEdge",
  relativeStrength: "SIA",
  aiRating: "BoostedAI",
  charting: "Technicals",
  analystConsensus: "Analyst consensus",
  researchMentions: "Research mentions",
  researchCoverage: "Research coverage",
  growth: "Growth",
  relativeValuation: "Rel. valuation",
  historicalValuation: "Hist. valuation",
  leverageCoverage: "Leverage",
  cashFlowQuality: "Cash-flow quality",
  brand: "Brand",
  secular: "Secular",
};

/** Human label for a category key — the map above, else a spaced-out key. */
function categoryLabel(key: ScoreKey): string {
  return CATEGORY_LABELS[key] ?? String(key).replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

function biggestCategoryMove(prev: Scores, cur: Scores): { key: ScoreKey; delta: number } | null {
  let best: { key: ScoreKey; delta: number } | null = null;
  const keys = new Set<string>([...Object.keys(prev || {}), ...Object.keys(cur || {})]);
  for (const k of keys) {
    const d = (cur?.[k as ScoreKey] ?? 0) - (prev?.[k as ScoreKey] ?? 0);
    if (d === 0) continue;
    if (!best || Math.abs(d) > Math.abs(best.delta)) best = { key: k as ScoreKey, delta: d };
  }
  return best;
}

function fmtSigned(n: number, digits = 1): string {
  const r = Number(n.toFixed(digits));
  return (r > 0 ? "+" : "") + r;
}

export type ComputeInput = {
  scoreHistory: ScoreHistoryStore;
  stocks: Stock[];
  snapshots: AnalystSnapshots;
  /** ticker → price when the rolling baseline was taken. */
  priceBaseline: Record<string, number>;
  /** Append-only log of tickers dropped from research lists (pm:research-removals). */
  researchRemovals: ResearchRemovalStore;
  /** Current tickers per research source (upper-cased), so a "drop" that has
   *  since been re-added (e.g. a name that was only on the 2nd screenshot of a
   *  multi-part list) is suppressed. Keyed by RemovalSource. */
  researchCurrentTickers?: Record<string, Set<string>>;
  windowDays: number;
  /** ms "now" — passed in so the function stays pure/testable. */
  nowMs: number;
};

export function computeChangeEvents(input: ComputeInput): ChangeEvent[] {
  const { scoreHistory, stocks, snapshots, priceBaseline, researchRemovals, researchCurrentTickers, windowDays, nowMs } = input;
  const windowStartMs = nowMs - windowDays * 24 * 60 * 60 * 1000;
  const events: ChangeEvent[] = [];
  const byTicker = new Map<string, Stock>();
  for (const s of stocks) byTicker.set(s.ticker.toUpperCase(), s);
  const nameFor = (t: string) => byTicker.get(t.toUpperCase())?.name;
  const bucketFor = (t: string) => byTicker.get(t.toUpperCase())?.bucket as "Portfolio" | "Watchlist" | undefined;

  // ── 1. Rating / composite changes from score-history ──────────────
  for (const [ticker, entriesRaw] of Object.entries(scoreHistory)) {
    const entries = (entriesRaw as ScoreHistoryEntry[])
      .filter((e) => e && typeof e.adjusted === "number" && typeof e.timestamp === "string")
      .slice()
      .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (entries.length < 2) continue;

    const latest = entries[entries.length - 1];
    // Baseline = the last entry that predates the window (the state entering
    // it); if every entry is inside the window, use the earliest one.
    let baseline: ScoreHistoryEntry | undefined;
    for (const e of entries) {
      if (Date.parse(e.timestamp) < windowStartMs) baseline = e;
    }
    if (!baseline) baseline = entries[0];
    if (baseline === latest) continue;
    if (Date.parse(latest.timestamp) < windowStartMs) continue; // nothing changed in-window

    const dAdj = latest.adjusted - baseline.adjusted;
    const tierBefore = ratingTier(baseline.adjusted);
    const tierAfter = ratingTier(latest.adjusted);
    const big = biggestCategoryMove(baseline.scores, latest.scores);
    const driver = big
      ? `${categoryLabel(big.key)} ${fmtSigned(big.delta, 0)} drove it; composite ${baseline.adjusted.toFixed(0)} → ${latest.adjusted.toFixed(0)}`
      : `Composite ${baseline.adjusted.toFixed(0)} → ${latest.adjusted.toFixed(0)}`;

    if (tierBefore !== tierAfter) {
      events.push({
        id: `${ticker}:rating:${latest.date}`,
        ticker, name: nameFor(ticker), bucket: bucketFor(ticker),
        type: "rating",
        severity: dAdj >= 0 ? "up" : "down",
        headline: `${ratingLabel(baseline.adjusted)} → ${ratingLabel(latest.adjusted)}`,
        detail: driver,
        delta: fmtSigned(dAdj),
        at: latest.date,
      });
    } else if (Math.abs(dAdj) >= THRESHOLDS.compositeMove) {
      events.push({
        id: `${ticker}:score:${latest.date}`,
        ticker, name: nameFor(ticker), bucket: bucketFor(ticker),
        type: "score",
        severity: dAdj >= 0 ? "up" : "down",
        headline: `Composite ${fmtSigned(dAdj)} (${ratingLabel(latest.adjusted)})`,
        detail: driver,
        delta: fmtSigned(dAdj),
        at: latest.date,
      });
    }
  }

  // ── 2. Analyst-target updates within the window ───────────────────
  for (const [ticker, snap] of Object.entries(snapshots)) {
    if (!snap) continue;
    for (const src of ["rbc", "jpm"] as const) {
      const e = snap[src];
      const stampStr = e?.lastUpdated || e?.asOf;
      if (!e || typeof e.target !== "number" || !stampStr) continue;
      const stamp = Date.parse(stampStr.length === 10 ? `${stampStr}T00:00:00Z` : stampStr);
      if (!Number.isFinite(stamp) || stamp < windowStartMs) continue;
      events.push({
        id: `${ticker}:target:${src}:${e.asOf || stampStr.slice(0, 10)}`,
        ticker, name: nameFor(ticker), bucket: bucketFor(ticker),
        type: "target",
        severity: "info",
        headline: `New ${src.toUpperCase()} target $${e.target}`,
        detail: `${e.rating ? `${e.rating} · ` : ""}as of ${(e.asOf || stampStr).slice(0, 10)}`,
        delta: undefined,
        at: (e.asOf || stampStr).slice(0, 10),
      });
    }
  }

  // ── 2b. Research-list removals within the window ──────────────────
  // A name dropped from an analyst focus / research list (replace-mode
  // screenshot or emailed list no longer containing it). Logged append-only
  // to pm:research-removals, bucketed by date.
  for (const [date, entries] of Object.entries(researchRemovals || {})) {
    const dayMs = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(dayMs) || dayMs < windowStartMs) continue;
    for (const r of entries || []) {
      if (!r?.ticker || !r?.source) continue;
      const T = r.ticker.toUpperCase();
      // Suppress a "drop" if the name is CURRENTLY still in that list — it was
      // re-added after the removal was logged (e.g. it lives on the 2nd
      // screenshot of a multi-part list, or the PM re-added it). Only a genuine
      // absence should surface as a List-drop event.
      if (researchCurrentTickers?.[r.source]?.has(T)) continue;
      events.push({
        id: `${T}:research-removed:${r.source}:${date}`,
        ticker: r.ticker, name: nameFor(T), bucket: bucketFor(T),
        type: "research-removed",
        severity: "warn",
        headline: `Dropped from ${r.sourceLabel || r.source}`,
        detail: `No longer in the ${r.sourceLabel || r.source} list — thesis check`,
        delta: undefined,
        at: date,
      });
    }
  }

  // ── 3. Per-stock current conditions (price / signal split / stale) ─
  const todayIso = new Date(nowMs).toISOString().slice(0, 10);
  for (const s of stocks) {
    if (!isScoreable(s)) continue;
    const T = s.ticker.toUpperCase();

    // Price move vs rolling baseline.
    const base = priceBaseline[T];
    if (typeof base === "number" && base > 0 && typeof s.price === "number" && s.price > 0) {
      const pct = ((s.price - base) / base) * 100;
      if (Math.abs(pct) >= THRESHOLDS.priceMovePct) {
        events.push({
          id: `${T}:price:${todayIso}`,
          ticker: s.ticker, name: s.name, bucket: s.bucket as "Portfolio" | "Watchlist",
          type: "price",
          severity: pct >= 0 ? "up" : "down",
          headline: `${fmtSigned(pct)}% this week`,
          detail: pct < 0 ? "Price fell — thesis check / possible add" : "Up sharply",
          delta: `${fmtSigned(pct)}%`,
          at: todayIso,
        });
      }
    }

    // Signal divergence: external category scores (each 0-2) strongly disagree.
    const ext: { label: string; v: number }[] = [];
    if (typeof s.scores?.relativeStrength === "number") ext.push({ label: "SIA", v: s.scores.relativeStrength });
    if (typeof s.scores?.aiRating === "number") ext.push({ label: "BoostedAI", v: s.scores.aiRating });
    if (marketEdgeApplies(s) && typeof s.scores?.marketEdge === "number") ext.push({ label: "MarketEdge", v: s.scores.marketEdge });
    if (ext.length >= 2) {
      const hi = ext.reduce((a, b) => (b.v > a.v ? b : a));
      const lo = ext.reduce((a, b) => (b.v < a.v ? b : a));
      if (hi.v - lo.v >= 2) {
        events.push({
          id: `${T}:signal:${hi.label}-${lo.label}`,
          ticker: s.ticker, name: s.name, bucket: s.bucket as "Portfolio" | "Watchlist",
          type: "signal",
          severity: "warn",
          headline: `${hi.label} strong, ${lo.label} weak`,
          detail: "Independent signals disagree — worth a look",
          at: todayIso,
        });
      }
    }

    // Data going stale: a source's last read is older than staleDays.
    const staleMs = nowMs - THRESHOLDS.staleDays * 24 * 60 * 60 * 1000;
    const staleSrcs: string[] = [];
    if (s.siaLastReadAt && Date.parse(s.siaLastReadAt) < staleMs) staleSrcs.push("SIA");
    if (s.boostedLastReadAt && Date.parse(s.boostedLastReadAt) < staleMs) staleSrcs.push("BoostedAI");
    if (staleSrcs.length > 0) {
      events.push({
        id: `${T}:data:${staleSrcs.join("-")}`,
        ticker: s.ticker, name: s.name, bucket: s.bucket as "Portfolio" | "Watchlist",
        type: "data",
        severity: "warn",
        headline: `${staleSrcs.join(" + ")} value going stale`,
        detail: `Not refreshed in ${THRESHOLDS.staleDays}+ days — re-send to keep the score current`,
        at: todayIso,
      });
    }
  }

  // Deteriorating first, then by recency.
  const sevRank: Record<Severity, number> = { down: 0, warn: 1, info: 2, up: 3 };
  events.sort((a, b) => sevRank[a.severity] - sevRank[b.severity] || Date.parse(b.at) - Date.parse(a.at));
  return events;
}
