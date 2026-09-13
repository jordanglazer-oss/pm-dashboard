/**
 * Setup grade — the timing layer that sits BESIDE the conviction score.
 *
 * Rubric v3 pulls the four technical categories out of the composite: they
 * are all price-derived (one signal counted four times), they are the
 * fastest-moving inputs (a fifth of historical rescores moved nothing but
 * technicals; 19 of 33 rating flips would not have happened without them),
 * and they answer "when", not "what is this business worth owning". Here
 * they become a 0–10 setup score with a five-step grade, so the PM reads
 * two axes — conviction × setup — instead of one blended number.
 *
 *   Input             Points   Source
 *   SIA SMAX           0–2     stock.scores.relativeStrength (existing tier map)
 *   BoostedAI          0–2     stock.scores.aiRating (existing map, clamped ≥ 0)
 *   MarketEdge         0–2     stock.scores.marketEdge (existing Opinion map)
 *   Charting (PM)      0–3     stock.scores.charting, 1-for-1, ONLY once the PM has
 *                              actually scored it (see below), with staleness
 *
 * The BASE grade is out of 6 (the three imported feeds). It becomes out of 9
 * when the PM has scored charting. Charting is rarely filled in and a stored
 * 0 used to be indistinguishable from "never looked at it", so the rule is:
 * charting counts iff the value is > 0 OR the PM has stamped it (a
 * manualScoredAt.charting date, written by every manual edit — so clicking
 * "0" is an explicit, real 0). Anything else is n/a and the grade stays /6.
 * Price vs the 200-day is reported as a note, not points — it overlaps SIA
 * and MarketEdge on trend and Jordan asked for the base to be exactly the
 * three feeds.
 *
 * Missing inputs ABSTAIN: the grade is read on the points present
 * (minimum two feeds), normalised to a 0–10 band for the five grades. No
 * hysteresis — setup is allowed to move fast; that is the point of
 * separating it from conviction.
 *
 * Two deterioration flags each knock the grade down one notch regardless of
 * the points: MarketEdge "Long but deteriorating" (marketEdgeWarning) and an
 * SIA percentile drop from pm:sia-history (the drift SMAX alone hides).
 *
 * Charting staleness: the PM's read is the only input that sees structure
 * (bases, breakouts, levels) rather than momentum, which is why it keeps a
 * 3-point ceiling — but a 3 entered four months ago is still a 3 while the
 * three feeds have refreshed many times. So: ≤ CHARTING_FRESH_DAYS full
 * weight; ≤ CHARTING_STALE_DAYS half weight (flagged); older → abstains
 * (flagged); undated → full weight, flagged "age unknown".
 *
 * Pure function over fields already on the Stock record. No Redis, no I/O.
 */

import type { Stock } from "./types";
import { boostedAiApplies, marketEdgeApplies, siaApplies } from "./scoring";
import { marketEdgeWarning } from "./external-scoring";

export type SetupGrade = "Strong" | "Constructive" | "Neutral" | "Weak" | "Broken";

/** Grade bands are read on a 0–10 normalisation of the points present. */
export const SETUP_MAX = 10;
/** The three imported feeds — the base out-of. */
export const SETUP_BASE_MAX = 6;
/** Base + PM charting. */
export const SETUP_FULL_MAX = 9;
export const CHARTING_FRESH_DAYS = 45;
export const CHARTING_STALE_DAYS = 90;
/** Percentile-point drop in SIA relative strength that knocks a notch. Mirrors
 *  THRESHOLDS.siaPercentileDrop in change-monitor.ts (kept literal here so
 *  this module has no dependency on the monitor). */
export const SIA_DROP_NOTCH = 15;
/** Fewer present inputs than this → no grade (not enough evidence). */
export const MIN_INPUTS = 2;

export type SetupInputKey = "sia" | "boostedAi" | "marketEdge" | "charting";

export type SetupInput = {
  key: SetupInputKey;
  label: string;
  /** Points contributed (after any staleness weighting). null when absent. */
  points: number | null;
  max: number;
  present: boolean;
  /** Short human note: "SMAX 8", "above rising 200d", "stale (61d)". */
  note?: string;
  stale?: boolean;
};

export type SetupFlag = {
  kind: "marketedge-deteriorating" | "sia-percentile-drop" | "marketedge-reversal-watch" | "charting-stale" | "charting-age-unknown" | "charting-unscored" | "trend-below-200d" | "trend-above-200d";
  label: string;
  /** Whether this flag knocks the grade down one notch. */
  notch: boolean;
};

export type SetupResult = {
  /** 0–SETUP_MAX normalisation of the points present (grade bands). null when < MIN_INPUTS. */
  score: number | null;
  /** Points actually summed and the out-of: 6 (feeds only) or 9 (charting scored), less any absent feed. */
  rawPoints: number;
  availableMax: number;
  /** Whether the PM's charting read is counted (the /9 case). */
  chartingScored: boolean;
  /** Grade after notches. null when < MIN_INPUTS present. */
  grade: SetupGrade | null;
  /** Grade from points alone, before notches. */
  gradeBeforeNotches: SetupGrade | null;
  notches: number;
  inputs: SetupInput[];
  flags: SetupFlag[];
};

export type SetupContext = {
  /** Latest SIA percentile move (to − from), from siaPercentileDrift(). */
  siaPercentileDelta?: number | null;
  /** Injected for tests / server renders; defaults to Date.now(). */
  nowMs?: number;
};

const GRADES: SetupGrade[] = ["Broken", "Weak", "Neutral", "Constructive", "Strong"];

export function gradeForScore(score: number): SetupGrade {
  if (score >= 8) return "Strong";
  if (score >= 6) return "Constructive";
  if (score >= 4) return "Neutral";
  if (score >= 2) return "Weak";
  return "Broken";
}

function knock(grade: SetupGrade, notches: number): SetupGrade {
  const idx = Math.max(0, GRADES.indexOf(grade) - notches);
  return GRADES[idx];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function daysBetween(fromISO: string, nowMs: number): number | null {
  const t = Date.parse(fromISO.length === 10 ? `${fromISO}T00:00:00Z` : fromISO);
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / 86400000);
}

/** Price vs the 200-day, as a note only (no points — see header). */
function trendFlag(stock: Stock): SetupFlag | null {
  const price = typeof stock.price === "number" && stock.price > 0 ? stock.price : null;
  const sma50 = stock.technicals?.sma50 ?? stock.healthData?.fiftyDayAvg ?? null;
  const sma200 = stock.technicals?.sma200 ?? stock.healthData?.twoHundredDayAvg ?? null;
  if (price == null || typeof sma200 !== "number" || !(sma200 > 0)) return null;
  if (price <= sma200) return { kind: "trend-below-200d", label: "Below the 200-day", notch: false };
  const rising = typeof sma50 === "number" && sma50 > 0 ? sma50 > sma200 : null;
  return { kind: "trend-above-200d", label: rising === false ? "Above the 200-day (50 < 200)" : "Above the 200-day", notch: false };
}

/** The PM has actually scored charting: a non-zero value, or an explicit
 *  edit stamp (so a clicked "0" is a real 0). A bare stored 0 is n/a. */
export function chartingIsScored(stock: Pick<Stock, "scores" | "manualScoredAt">): boolean {
  const raw = stock.scores?.charting;
  if (typeof raw === "number" && raw > 0) return true;
  return typeof stock.manualScoredAt?.charting === "string" && stock.manualScoredAt.charting.length > 0;
}

function chartingInput(stock: Stock, nowMs: number, flags: SetupFlag[]): SetupInput {
  const raw = stock.scores?.charting;
  if (!chartingIsScored(stock) || typeof raw !== "number") {
    flags.push({ kind: "charting-unscored", label: "Charting not scored — grade is /6", notch: false });
    return { key: "charting", label: "Charting (PM)", points: null, max: 3, present: false, note: "n/a — not scored" };
  }
  const value = clamp(raw, 0, 3);
  const dated = stock.manualScoredAt?.charting;
  if (!dated) {
    flags.push({ kind: "charting-age-unknown", label: "Charting age unknown", notch: false });
    return { key: "charting", label: "Charting (PM)", points: value, max: 3, present: true, note: "age unknown" };
  }
  const age = daysBetween(dated, nowMs);
  if (age == null) {
    flags.push({ kind: "charting-age-unknown", label: "Charting age unknown", notch: false });
    return { key: "charting", label: "Charting (PM)", points: value, max: 3, present: true, note: "age unknown" };
  }
  if (age <= CHARTING_FRESH_DAYS) {
    return { key: "charting", label: "Charting (PM)", points: value, max: 3, present: true, note: `${age}d old` };
  }
  if (age <= CHARTING_STALE_DAYS) {
    flags.push({ kind: "charting-stale", label: `Charting stale (${age}d) — half weight`, notch: false });
    return { key: "charting", label: "Charting (PM)", points: Math.round(value * 0.5 * 10) / 10, max: 3, present: true, note: `stale (${age}d), half weight`, stale: true };
  }
  flags.push({ kind: "charting-stale", label: `Charting ${age}d old — excluded`, notch: false });
  return { key: "charting", label: "Charting (PM)", points: null, max: 3, present: false, note: `${age}d old, excluded`, stale: true };
}

export function computeSetup(stock: Stock, ctx: SetupContext = {}): SetupResult {
  const nowMs = ctx.nowMs ?? Date.now();
  const flags: SetupFlag[] = [];
  const inputs: SetupInput[] = [];

  // SIA — the stored relativeStrength IS the SMAX tier map output.
  if (siaApplies(stock)) {
    const pts = clamp(stock.scores.relativeStrength || 0, 0, 2);
    inputs.push({ key: "sia", label: "SIA", points: pts, max: 2, present: true, note: typeof stock.sia === "number" ? `SMAX ${stock.sia}` : undefined });
  } else {
    inputs.push({ key: "sia", label: "SIA", points: null, max: 2, present: false, note: "no SMAX" });
  }

  // BoostedAI — the combined map can go negative; the setup layer floors at 0
  // (a bearish AI read is "no support", the deterioration signal lives in the
  // rating itself, which the PM sees on the input block).
  if (boostedAiApplies(stock)) {
    const pts = clamp(stock.scores.aiRating || 0, 0, 2);
    inputs.push({ key: "boostedAi", label: "BoostedAI", points: pts, max: 2, present: true, note: typeof stock.boostedAi === "number" ? `rating ${stock.boostedAi}` : undefined });
  } else {
    inputs.push({ key: "boostedAi", label: "BoostedAI", points: null, max: 2, present: false, note: "no rating" });
  }

  // MarketEdge — Opinion-aligned 0/1/2.
  if (marketEdgeApplies(stock) && (stock.marketEdge?.powerRating != null || stock.marketEdge?.opinion != null || (stock.scores.marketEdge || 0) !== 0)) {
    const pts = clamp(stock.scores.marketEdge || 0, 0, 2);
    const pr = stock.marketEdge?.powerRating;
    inputs.push({ key: "marketEdge", label: "MarketEdge", points: pts, max: 2, present: true, note: pr != null ? `power ${pr}` : stock.marketEdge?.opinion });
    const warn = marketEdgeWarning(stock.marketEdge?.opinion, stock.marketEdge?.opinionScore);
    if (warn) {
      flags.push(
        warn.kind === "deteriorating"
          ? { kind: "marketedge-deteriorating", label: "MarketEdge: technicals deteriorating", notch: true }
          : { kind: "marketedge-reversal-watch", label: "MarketEdge: reversal watch", notch: false },
      );
    }
  } else {
    inputs.push({ key: "marketEdge", label: "MarketEdge", points: null, max: 2, present: false, note: "no power rating" });
  }

  const charting = chartingInput(stock, nowMs, flags);
  inputs.push(charting);
  const trend = trendFlag(stock);
  if (trend) flags.push(trend);

  // SIA percentile drift — the drift SMAX hides.
  if (typeof ctx.siaPercentileDelta === "number" && ctx.siaPercentileDelta <= -SIA_DROP_NOTCH) {
    flags.push({ kind: "sia-percentile-drop", label: `SIA percentile ${ctx.siaPercentileDelta.toFixed(0)} pts`, notch: true });
  }

  const present = inputs.filter((i) => i.present && i.points != null);
  const rawPoints = Math.round(present.reduce((s, i) => s + (i.points as number), 0) * 10) / 10;
  const availableMax = present.reduce((s, i) => s + i.max, 0);
  const chartingScored = charting.present && charting.points != null;
  if (present.length < MIN_INPUTS || availableMax <= 0) {
    return { score: null, rawPoints, availableMax, chartingScored, grade: null, gradeBeforeNotches: null, notches: 0, inputs, flags };
  }
  const score = Math.round((rawPoints / availableMax) * SETUP_MAX * 10) / 10;
  const gradeBeforeNotches = gradeForScore(score);
  const notches = flags.filter((f) => f.notch).length;
  const grade = knock(gradeBeforeNotches, notches);
  return { score, rawPoints, availableMax, chartingScored, grade, gradeBeforeNotches, notches, inputs, flags };
}

/** Tone for a grade, matching the rating tones used elsewhere. */
export function setupTone(grade: SetupGrade | null): "pos" | "warn" | "neg" | "muted" {
  if (grade == null) return "muted";
  if (grade === "Strong" || grade === "Constructive") return "pos";
  if (grade === "Neutral") return "warn";
  return "neg";
}

/**
 * The two-axis read: what to DO given conviction and setup. Conviction is
 * the rating label from the composite; setup is the grade from here.
 */
export function actionFor(conviction: string, grade: SetupGrade | null): string {
  if (grade == null) return "Setup unknown";
  const strongSetup = grade === "Strong" || grade === "Constructive";
  const brokenSetup = grade === "Weak" || grade === "Broken";
  switch (conviction) {
    case "Strong Buy":
      return strongSetup ? "Buy now" : brokenSetup ? "Wait — thesis intact, setup not" : "Accumulate";
    case "Moderate Buy":
      return strongSetup ? "Buy" : brokenSetup ? "Wait for setup" : "Accumulate slowly";
    case "Hold":
      return strongSetup ? "Trade only" : brokenSetup ? "Trim" : "Hold";
    case "Underweight":
      return strongSetup ? "Exit on strength" : brokenSetup ? "Exit" : "Reduce";
    default:
      return strongSetup ? "Exit on strength" : "Exit";
  }
}
