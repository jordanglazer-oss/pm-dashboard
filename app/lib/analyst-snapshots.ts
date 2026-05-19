/**
 * Analyst snapshot storage shape + deterministic scoring for the
 * `analystConsensus` Research sub-category (max 3).
 *
 * The snapshot is a single Redis blob at `pm:analyst-snapshots` keyed by
 * canonical ticker. Each ticker holds at most three records — RBC, JPM,
 * and a FactSet street-consensus row (manually entered until API access
 * lands). The blob is server-rendered into a per-stock entry that can be
 * partially populated (e.g. RBC only, no JPM, no FactSet).
 *
 * Scoring is deterministic — `computeAnalystConsensus` is a pure function
 * over (snapshot, currentPrice) → ConsensusBreakdown. The score route
 * overrides any LLM-emitted value with this output before responding.
 */

import { canonicalTicker } from "./ticker";

export type AnalystRating = "outperform" | "neutral" | "underperform" | "not-covered";

export type AnalystEntry = {
  rating: AnalystRating;
  /** Analyst's price target. Numeric; currency is implicit from the ticker. */
  target?: number;
  /** YYYY-MM-DD — date of the report or the rating-as-of date. */
  asOf?: string;
  /** Underlying price at the time of the report. Auto-filled from current
   *  Yahoo price at save time; user can override. Drives convergence-based
   *  freshness decay (target hit / adverse move). */
  priceAtReport?: number;
  /** Optional reference to an uploaded PDF (step 3b). */
  reportId?: string;
  /** ISO timestamp of the last edit. Audit-only. */
  lastUpdated?: string;
};

export type FactSetEntry = {
  averageTarget?: number;
  analystCount?: number;
  asOf?: string;
  lastUpdated?: string;
};

export type TickerSnapshot = {
  rbc?: AnalystEntry;
  jpm?: AnalystEntry;
  factset?: FactSetEntry;
};

export type AnalystSnapshots = Record<string, TickerSnapshot>;

// ── Report manifest (PDF extractions) ─────────────────────────────────

export type ExtractedReport = {
  rating?: AnalystRating;
  target?: number;
  asOf?: string;
  thesis?: string[];
  risks?: string[];
  sectorView?: string;
  keyMetrics?: { label: string; value: string }[];
};

export type ReportMeta = {
  /** Deterministic id: `<canonicalTicker>-<source>`. The PDF dataUrl lives at
   *  pm:analyst-report-pdf:<id>; the manifest only holds metadata. */
  id: string;
  /** User-supplied label (e.g. "Q1 2026 update"). Falls back to the file name
   *  the user uploaded. */
  label: string;
  /** Timestamp the manifest entry was last written. Updates on every
   *  persist, including cached-retry re-ingestions where the underlying
   *  data didn't actually change. Kept for backward compat / audit. */
  uploadedAt: string;
  /** Timestamp the EXTRACTED DATA in this entry was originally produced by
   *  Anthropic. This is taken from extractAnalystReport's cached result on
   *  cache hits, so it doesn't drift forward on retry re-ingestions. When
   *  a different PDF replaces the slot, this becomes the new fresh-extract
   *  date. Optional for backward compat — entries written before this field
   *  was added fall back to uploadedAt in the UI. */
  extractedAt?: string;
  /** SHA-256 of the source dataUrl — same PDF → same hash → cache hit. */
  hash: string;
  extracted: ExtractedReport;
};

export type TickerReports = {
  rbc?: ReportMeta;
  jpm?: ReportMeta;
};

export type AnalystReports = Record<string, TickerReports>;

export function reportIdFor(ticker: string, source: "rbc" | "jpm"): string {
  return `${canonicalTicker(ticker)}-${source}`;
}

export function getReportsForTicker(blob: AnalystReports | undefined, ticker: string): TickerReports | undefined {
  if (!blob) return undefined;
  const key = canonicalTicker(ticker);
  if (blob[key]) return blob[key];
  return blob[ticker.toUpperCase()];
}

export function setReportsForTicker(blob: AnalystReports, ticker: string, next: TickerReports | undefined): AnalystReports {
  const key = canonicalTicker(ticker);
  const out: AnalystReports = { ...blob };
  if (!next || (!next.rbc && !next.jpm)) {
    delete out[key];
    delete out[ticker.toUpperCase()];
  } else {
    out[key] = next;
    if (ticker.toUpperCase() !== key) delete out[ticker.toUpperCase()];
  }
  return out;
}

// ── Pure scoring helpers ───────────────────────────────────────────────

export function ratingScore(rating: AnalystRating): number {
  if (rating === "outperform") return 1.0;
  if (rating === "neutral") return 0.5;
  if (rating === "underperform") return 0.0;
  return 0; // not-covered contributes nothing
}

export type FreshnessLabel = "fresh" | "stale" | "very-stale";
export type FreshnessResult = { weight: number; label: FreshnessLabel; reason?: string };

/**
 * Per-analyst freshness multiplier (0.5–1.0). Applied to the rating score
 * only — the upside sub-point is naturally self-correcting since it
 * recomputes against current price every score.
 *
 * Rules (any one triggers the 0.5 stale floor):
 *   - >180 days since report
 *   - >90 days since report (linear taper 1.0 → 0.5 over the 90–180 window)
 *   - Target hit (current price ≥ target)
 *   - Price moved <-20% from priceAtReport AND >60 days since report
 */
export function freshnessWeight(entry: AnalystEntry, currentPrice?: number): FreshnessResult {
  const reasons: string[] = [];
  const now = Date.now();
  const asOfMs = entry.asOf ? Date.parse(entry.asOf) : NaN;
  const daysSince = Number.isFinite(asOfMs) ? (now - asOfMs) / (1000 * 60 * 60 * 24) : 0;

  let weight = 1.0;
  let label: FreshnessLabel = "fresh";

  if (daysSince > 180) {
    weight = 0.5;
    label = "very-stale";
    reasons.push(`Report is ${Math.floor(daysSince)} days old`);
  } else if (daysSince > 90) {
    weight = 1.0 - 0.5 * ((daysSince - 90) / 90);
    label = "stale";
    reasons.push(`Report is ${Math.floor(daysSince)} days old`);
  }

  if (entry.target && currentPrice && currentPrice >= entry.target) {
    if (weight > 0.5) weight = 0.5;
    if (label === "fresh") label = "stale";
    reasons.push(`Target $${entry.target.toFixed(2)} reached (price $${currentPrice.toFixed(2)})`);
  }

  if (entry.priceAtReport && currentPrice && daysSince > 60) {
    const move = (currentPrice - entry.priceAtReport) / entry.priceAtReport;
    if (move < -0.2) {
      if (weight > 0.5) weight = 0.5;
      if (label === "fresh") label = "stale";
      reasons.push(`Price down ${(move * 100).toFixed(0)}% from report-time level`);
    }
  }

  return { weight, label, reason: reasons.join("; ") || undefined };
}

/** FactSet target → upside sub-point (0–1). */
export function upsideScore(target: number, currentPrice: number): number {
  if (!target || !currentPrice || currentPrice <= 0) return 0;
  const upside = (target - currentPrice) / currentPrice;
  if (upside >= 0.25) return 1.0;
  if (upside >= 0.10) return 0.75;
  if (upside >= 0) return 0.5;
  if (upside >= -0.10) return 0.25;
  return 0;
}

export type AnalystContribution = {
  rating: number;
  freshness: number;
  freshnessLabel: FreshnessLabel;
  freshnessReason?: string;
  contribution: number;
};

export type UpsideContribution = {
  target?: number;
  targetSource: "factset" | "none";
  upsidePercent?: number;
  contribution: number;
};

export type ConsensusBreakdown = {
  /** Final score, rounded to nearest 0.5, clamped to [0, 3]. */
  score: number;
  /** Pre-rounding sum of contributions. */
  rawScore: number;
  rbc: AnalystContribution | null;
  jpm: AnalystContribution | null;
  upside: UpsideContribution;
  confidence: "high" | "medium" | "low";
};

function analystContribution(entry: AnalystEntry | undefined, currentPrice?: number): AnalystContribution | null {
  if (!entry || entry.rating === "not-covered") return null;
  const rs = ratingScore(entry.rating);
  const fr = freshnessWeight(entry, currentPrice);
  return {
    rating: rs,
    freshness: fr.weight,
    freshnessLabel: fr.label,
    freshnessReason: fr.reason,
    contribution: rs * fr.weight,
  };
}

export function computeAnalystConsensus(
  snapshot: TickerSnapshot | undefined,
  currentPrice?: number
): ConsensusBreakdown {
  const rbc = analystContribution(snapshot?.rbc, currentPrice);
  const jpm = analystContribution(snapshot?.jpm, currentPrice);

  // Target: use FactSet street-average ONLY. RBC/JPM individual targets
  // are not used — the PM enters the FactSet consensus target explicitly
  // and doesn't want stale broker targets inflating/deflating the upside
  // component before FactSet data is entered.
  let target: number | undefined;
  let targetSource: UpsideContribution["targetSource"] = "none";
  const factsetTarget = snapshot?.factset?.averageTarget;
  if (typeof factsetTarget === "number" && factsetTarget > 0) {
    target = factsetTarget;
    targetSource = "factset";
  }

  const upsideContribution: UpsideContribution =
    target && currentPrice
      ? {
          target,
          targetSource,
          upsidePercent: ((target - currentPrice) / currentPrice) * 100,
          contribution: upsideScore(target, currentPrice),
        }
      : { target, targetSource, contribution: 0 };

  const rawScore = (rbc?.contribution ?? 0) + (jpm?.contribution ?? 0) + upsideContribution.contribution;
  const score = Math.max(0, Math.min(3, Math.round(rawScore * 2) / 2));

  // Confidence (informational only — UI doesn't render a chip for computed cats).
  const rbcFresh = rbc && rbc.freshnessLabel === "fresh";
  const jpmFresh = jpm && jpm.freshnessLabel === "fresh";
  const factsetFresh = (() => {
    if (!snapshot?.factset?.averageTarget || !snapshot.factset.asOf) return false;
    const days = (Date.now() - Date.parse(snapshot.factset.asOf)) / (1000 * 60 * 60 * 24);
    return Number.isFinite(days) && days <= 30;
  })();
  let confidence: "high" | "medium" | "low";
  if (rbcFresh && jpmFresh && factsetFresh) confidence = "high";
  else if (!rbc && !jpm && !target) confidence = "low";
  else if ((rbc || jpm) && target) confidence = "medium";
  else confidence = "medium";

  return { score, rawScore, rbc, jpm, upside: upsideContribution, confidence };
}

// ── Explanation builder ──────────────────────────────────────────────
//
// Builds a ScoreCategoryExplanation from a ConsensusBreakdown so that
// auto-derived score updates (FactSet edit, PDF upload/remove) also
// refresh the explanation text without requiring a full Claude rescore.

import type { ScoreCategoryExplanation, ScoreDataPoint } from "./types";

export function buildConsensusExplanation(
  breakdown: ConsensusBreakdown,
): ScoreCategoryExplanation {
  const dataPoints: ScoreDataPoint[] = [];

  if (breakdown.rbc) {
    const r = breakdown.rbc;
    dataPoints.push({
      label: "RBC",
      value: `${r.rating.toFixed(2)} × ${r.freshness.toFixed(2)} = ${r.contribution.toFixed(2)} pts (${r.freshnessLabel})`,
      source: "model",
    });
  }
  if (breakdown.jpm) {
    const j = breakdown.jpm;
    dataPoints.push({
      label: "JPM",
      value: `${j.rating.toFixed(2)} × ${j.freshness.toFixed(2)} = ${j.contribution.toFixed(2)} pts (${j.freshnessLabel})`,
      source: "model",
    });
  }
  if (breakdown.upside.target && breakdown.upside.upsidePercent !== undefined) {
    dataPoints.push({
      label: "Upside",
      value: `Target $${breakdown.upside.target.toFixed(2)} — ${breakdown.upside.upsidePercent >= 0 ? "+" : ""}${breakdown.upside.upsidePercent.toFixed(1)}% → ${breakdown.upside.contribution.toFixed(2)} pts`,
      source: "model",
      sourceDetail: "FactSet street avg",
    });
  } else if (breakdown.upside.targetSource === "none") {
    dataPoints.push({
      label: "Upside",
      value: "No FactSet target entered — upside component 0 pts",
      source: "model",
    });
  }

  const summary =
    dataPoints.length === 0
      ? "No analyst snapshot data available. Enter RBC/JPM reports and a FactSet target via the Coverage Checklist."
      : `Auto-derived from RBC + JPM ratings + FactSet street-avg upside. Raw sum: ${breakdown.rawScore.toFixed(2)}, rounded to ${breakdown.score}/3.`;

  return { summary, dataPoints, confidence: breakdown.confidence };
}

// ── Snapshot CRUD helpers ─────────────────────────────────────────────

export function getSnapshotForTicker(blob: AnalystSnapshots | undefined, ticker: string): TickerSnapshot | undefined {
  if (!blob) return undefined;
  const key = canonicalTicker(ticker);
  if (blob[key]) return blob[key];
  // Fallback to raw key (older data may not be canonicalized).
  return blob[ticker.toUpperCase()];
}

export function setSnapshotForTicker(blob: AnalystSnapshots, ticker: string, next: TickerSnapshot | undefined): AnalystSnapshots {
  const key = canonicalTicker(ticker);
  const out: AnalystSnapshots = { ...blob };
  if (!next || (!next.rbc && !next.jpm && !next.factset)) {
    delete out[key];
    delete out[ticker.toUpperCase()];
  } else {
    out[key] = next;
    // Clean up duplicate non-canonical key if it existed.
    if (ticker.toUpperCase() !== key) delete out[ticker.toUpperCase()];
  }
  return out;
}
