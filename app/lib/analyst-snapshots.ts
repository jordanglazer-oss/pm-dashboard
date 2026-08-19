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
  /** Analyst's price target, converted to the stock's trading currency.
   *  If the PDF target was in a different currency, this stores the
   *  converted value; the original is in `targetOriginal`. */
  target?: number;
  /** Original target as extracted from the PDF (before FX conversion).
   *  Only set when conversion occurred; absent when no conversion needed. */
  targetOriginal?: number;
  /** Currency of the original target from the PDF (e.g. "USD", "CAD").
   *  Only set when conversion occurred. */
  targetCurrency?: string;
  /** FX rate used for conversion (e.g. USDCAD rate). Audit trail. */
  fxRate?: number;
  /**
   * The currency THIS provider quotes THIS name in, as corrected by the PM.
   *
   * Set whenever the currency is chosen by hand, and applied to every later
   * report from the same provider for the same ticker — overriding whatever
   * the extractor guesses. Dual-listed names are the case that needs it: a
   * TSX-listed ticker looks like CAD, but RBC and JPM publish Shopify targets
   * in USD, so the extractor's exchange-based guess is wrong every single
   * time and had to be re-corrected on every upload.
   *
   * Still only a DEFAULT — picking a different currency overwrites it, so a
   * genuine change of quoting basis is one click, same as before.
   */
  preferredCurrency?: string;
  /** YYYY-MM-DD — date of the report or the rating-as-of date. */
  asOf?: string;
  /** Underlying price at the time of the report. Auto-filled from current
   *  Yahoo price at save time; user can override. */
  priceAtReport?: number;
  /** Optional reference to an uploaded PDF (step 3b). */
  reportId?: string;
  /** ISO timestamp of the last edit. Audit-only. */
  lastUpdated?: string;
};

export type FactSetEntry = {
  averageTarget?: number;
  analystCount?: number;
  /** FactSet EPS FY+1 estimate revisions over the last 30 days (up vs down count).
   *  Drives estimate-revision momentum on the Conviction Board + Change Monitor. */
  revUp?: number;
  revDown?: number;
  asOf?: string;
  lastUpdated?: string;
};

/** Morningstar's structured ratings — populated automatically when a
 *  Morningstar report PDF is uploaded (analyst-extract), or entered by hand.
 *  Stars enter analystConsensus as a symmetric MODIFIER (±0.5) — the
 *  independent, price-disciplined voice against a sell-side panel. The FVE
 *  itself is deliberately NOT an upside input (stars already encode
 *  price-vs-FVE; using both would double-count inside one category). */
export type MorningstarEntry = {
  /** Star rating 1-5. */
  stars?: number;
  /** Fair Value Estimate (report currency). Cross-check display only. */
  fairValue?: number;
  moat?: "wide" | "narrow" | "none";
  moatTrend?: "positive" | "stable" | "negative";
  capitalAllocation?: "exemplary" | "standard" | "poor";
  uncertainty?: "low" | "medium" | "high" | "very-high" | "extreme";
  /** YYYY-MM-DD — report date. */
  asOf?: string;
  lastUpdated?: string;
};

export type TickerSnapshot = {
  rbc?: AnalystEntry;
  jpm?: AnalystEntry;
  factset?: FactSetEntry;
  morningstar?: MorningstarEntry;
};

export type AnalystSnapshots = Record<string, TickerSnapshot>;

// ── Report manifest (PDF extractions) ─────────────────────────────────

export type ExtractedReport = {
  rating?: AnalystRating;
  target?: number;
  /** Currency of the extracted target price (e.g. "USD", "CAD").
   *  Extracted from the PDF by the Anthropic model. Used to convert the
   *  target to the stock's trading currency before storing in the snapshot. */
  targetCurrency?: string;
  asOf?: string;
  thesis?: string[];
  risks?: string[];
  sectorView?: string;
  keyMetrics?: { label: string; value: string }[];
  /** Morningstar-only structured ratings — populated when source === "morningstar". */
  stars?: number;
  fairValue?: number;
  moat?: "wide" | "narrow" | "none";
  moatTrend?: "positive" | "stable" | "negative";
  capitalAllocation?: "exemplary" | "standard" | "poor";
  uncertainty?: "low" | "medium" | "high" | "very-high" | "extreme";
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
  /** Public Vercel Blob URL of the original PDF. The raw PDF used to live in
   *  Redis at pm:analyst-report-pdf:<id> (multi-MB each → OOM); it now lives
   *  in Blob. Nothing in the app reads the PDF back today, so this is an
   *  archive pointer (a future "view original report" feature can use it).
   *  Undefined for entries whose PDF predates the migration / was dropped. */
  pdfUrl?: string;
};

export type TickerReports = {
  rbc?: ReportMeta;
  jpm?: ReportMeta;
  morningstar?: ReportMeta;
};

export type AnalystReports = Record<string, TickerReports>;

export function reportIdFor(ticker: string, source: "rbc" | "jpm" | "morningstar"): string {
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

/**
 * Level-component weight (audit Finding 06). The components used to sum to a
 * possible 4.5 before the [0,3] clamp: two Outperforms + 25% upside alone hit
 * 3.0, so the revision-momentum and Morningstar modifiers — the fast,
 * forward-looking signals — contributed NOTHING on exactly the
 * highest-conviction names. Ratings and upside now carry 0.75 each (level
 * ceiling 2.25), leaving 0.75 of live headroom: a well-liked name with
 * estimates being cut is now visibly different from one with estimates
 * being raised.
 */
export const RATING_WEIGHT = 0.75;

export function ratingScore(rating: AnalystRating): number {
  if (rating === "outperform") return RATING_WEIGHT;
  if (rating === "neutral") return RATING_WEIGHT / 2;
  if (rating === "underperform") return 0.0;
  return 0; // not-covered contributes nothing
}

export type FreshnessLabel = "fresh" | "stale" | "very-stale";
export type FreshnessResult = { weight: number; label: FreshnessLabel; reason?: string };

/**
 * Per-analyst freshness multiplier. Always 1.0 — no decay.
 *
 * Analysts keep their reports current when material changes occur, so
 * penalizing older reports distorts the score. The rating stands at full
 * weight until the PM uploads a newer report that replaces it.
 */
export function freshnessWeight(_entry: AnalystEntry, _currentPrice?: number): FreshnessResult {
  return { weight: 1.0, label: "fresh", reason: undefined };
}

/** FactSet target → upside sub-point (0–0.75; rescaled per Finding 06 so the
 *  level components cap at 2.25 and revisions/Morningstar keep headroom). */
export function upsideScore(target: number, currentPrice: number): number {
  if (!target || !currentPrice || currentPrice <= 0) return 0;
  const upside = (target - currentPrice) / currentPrice;
  if (upside >= 0.25) return 0.75;
  if (upside >= 0.10) return 0.55;
  if (upside >= 0) return 0.35;
  if (upside >= -0.10) return 0.2;
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

export type RevisionContribution = {
  up: number;
  down: number;
  net: number;
  /** ±1 max — the forward "direction of travel" modifier. */
  contribution: number;
};

export type ConsensusBreakdown = {
  /** Final score, clamped to [0, 3], kept at full precision (2 decimals). */
  score: number;
  /** Pre-rounding sum of contributions. */
  rawScore: number;
  rbc: AnalystContribution | null;
  jpm: AnalystContribution | null;
  upside: UpsideContribution;
  /** Estimate-revision momentum (FY+1 EPS, last 30d). Null when FactSet
   *  revisions haven't been imported for this name — absent ≠ bearish. */
  revisions: RevisionContribution | null;
  /** Morningstar star-rating modifier (±0.5). Null when no report uploaded. */
  morningstar: MorningstarContribution | null;
  confidence: "high" | "medium" | "low";
};

/** Revision-momentum modifier: net analyst FY+1 revisions → ±1 max.
 *  |net| ≥ 4 is a strong, corroborated move (full point); |net| ≥ 2 is a
 *  building move (half point); ±1 is noise (no effect). Thresholds match the
 *  conventions used by thesis-health / alerts (strong = 3-4 net). */
function revisionContribution(entry: FactSetEntry | undefined): RevisionContribution | null {
  if (!entry || (typeof entry.revUp !== "number" && typeof entry.revDown !== "number")) return null;
  const up = entry.revUp ?? 0;
  const down = entry.revDown ?? 0;
  const net = up - down;
  let contribution = 0;
  if (net >= 4) contribution = 1;
  else if (net >= 2) contribution = 0.5;
  else if (net <= -4) contribution = -1;
  else if (net <= -2) contribution = -0.5;
  return { up, down, net, contribution };
}

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

/** Morningstar star-rating modifier: a symmetric promoter/demoter (±0.5),
 *  NOT another additive rating stack — the components can already sum past
 *  the 3-pt clamp, and a fourth positive voice would pin more names at the
 *  ceiling and destroy discrimination. Stars are price/FVE-driven and thus
 *  contrarian vs the sell-side-momentum panel; a symmetric ± is the right
 *  shape for an independent check. Null when not uploaded — absent ≠ bearish. */
export type MorningstarContribution = { stars: number; contribution: number };
function morningstarContribution(entry: MorningstarEntry | undefined): MorningstarContribution | null {
  const stars = entry?.stars;
  if (typeof stars !== "number" || stars < 1 || stars > 5) return null;
  const contribution = stars >= 5 ? 0.5 : stars >= 4 ? 0.25 : stars <= 1 ? -0.5 : stars <= 2 ? -0.25 : 0;
  return { stars, contribution };
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

  // Revision momentum — the forward component. Acts as a promoter/demoter on
  // the level-based sum (ratings + upside, ceiling 2.25 after the Finding 06
  // rescale), so the level signal can no longer pin the [0,3] clamp on its
  // own: a maxed consensus with estimates being cut drops below 3; a middling
  // one with strong up-revisions rises. Null (not imported) contributes
  // nothing — absent ≠ bearish.
  const revisions = revisionContribution(snapshot?.factset);
  const morningstar = morningstarContribution(snapshot?.morningstar);

  const rawScore =
    (rbc?.contribution ?? 0) +
    (jpm?.contribution ?? 0) +
    upsideContribution.contribution +
    (revisions?.contribution ?? 0) +
    (morningstar?.contribution ?? 0);
  // Keep full precision (e.g. 2.75) — clamped to [0, 3] but NOT rounded.
  // The UI displays the exact fractional value; rounding was masking real
  // signal (e.g. 2.75 → 3 hid the missing 0.25).
  const score = Math.max(0, Math.min(3, Math.round(rawScore * 100) / 100));

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

  return { score, rawScore, rbc, jpm, upside: upsideContribution, revisions, morningstar, confidence };
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

  // Freshness decay was removed (freshnessWeight always returns 1.0),
  // so the previous "rating × multiplier = pts (fresh)" format was
  // just noise — the rating, the multiplier-product, and the
  // contribution were all identical. Surface the contribution
  // directly and drop the freshness label.
  if (breakdown.rbc) {
    dataPoints.push({
      label: "RBC",
      value: `${breakdown.rbc.contribution.toFixed(2)} pts`,
      source: "model",
    });
  }
  if (breakdown.jpm) {
    dataPoints.push({
      label: "JPM",
      value: `${breakdown.jpm.contribution.toFixed(2)} pts`,
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
  if (breakdown.revisions) {
    const r = breakdown.revisions;
    dataPoints.push({
      label: "Revisions",
      value: `FY+1 EPS ${r.up}↑/${r.down}↓ (net ${r.net >= 0 ? "+" : ""}${r.net}) → ${r.contribution >= 0 ? "+" : ""}${r.contribution.toFixed(1)} pts`,
      source: "model",
      sourceDetail: "FactSet 30d estimate revisions",
    });
  }
  if (breakdown.morningstar) {
    const m = breakdown.morningstar;
    dataPoints.push({
      label: "Morningstar",
      value: `${m.stars}★ → ${m.contribution >= 0 ? "+" : ""}${m.contribution.toFixed(2)} pts`,
      source: "model",
      sourceDetail: "Morningstar star rating (independent modifier)",
    });
  }

  const summary =
    dataPoints.length === 0
      ? "No analyst snapshot data available. Enter RBC/JPM reports and a FactSet target via the Coverage Checklist."
      : `Auto-derived from RBC + JPM ratings + FactSet street-avg upside, tilted ±1 by FY+1 estimate-revision momentum${breakdown.morningstar ? " and ±0.5 by the Morningstar star rating" : ""}. Score: ${breakdown.score}/3.`;

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
