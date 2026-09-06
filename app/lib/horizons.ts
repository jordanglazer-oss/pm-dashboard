/**
 * Multi-Horizon Regime Lens
 * ─────────────────────────
 * The composite Risk-On / Neutral / Risk-Off label is useful but flat — it
 * collapses signals that operate on totally different time scales into one
 * number. A VIX < 20 print tells you about the next 4-8 weeks, but the SPX
 * 10-month trend is a 6-12 month structural read; lumping them 1:1 mutes
 * what each one actually signals.
 *
 * This module re-projects the same signals across three horizons so the PM
 * can see what's true tactically vs structurally without re-fetching any
 * data:
 *
 *   • Tactical   (1–3M)  — flow, vol, short-term momentum.
 *                          Weight 50% in the overall composite.
 *   • Cyclical   (3–6M)  — sector rotation, business-cycle indicators
 *                          (ISM PMI 50-line crossover).
 *                          Weight 30% in the overall composite.
 *   • Structural (6–12M) — long-term trend (SPX 10M MA), PMI direction.
 *                          Weight 20% in the overall composite.
 *
 * Why these weights: PM trades on a multi-month horizon but rebalances
 * monthly, so tactical conditions dominate (50%). Cyclical drives sector
 * tilts and the Balanced sleeve cash level (30%). Structural is the
 * "don't fight the tape" overlay that vetoes tactical aggression when the
 * 10M trend rolls over (20%).
 *
 * Signal-to-horizon mapping is intentionally a SOFT classification — most
 * signals belong primarily to one horizon, but we don't double-count: a
 * given regime signal lives in exactly one horizon bucket. This keeps the
 * weighted overall composite mathematically clean.
 */

import type { RegimeDirection } from "./market-regime";

// ── Public types ──────────────────────────────────────────────────

export type Horizon = "tactical" | "cyclical" | "structural";

export type HorizonMeta = {
  id: Horizon;
  label: string; // e.g. "Tactical (1–3M)"
  shortLabel: string; // e.g. "1–3M"
  weight: number; // composite weighting; sums to 1.0 across horizons
  description: string; // hover tooltip — what this horizon captures
};

export const HORIZONS: readonly HorizonMeta[] = [
  {
    id: "tactical",
    label: "Tactical (1–3M)",
    shortLabel: "1–3M",
    weight: 0.5,
    description:
      "Short-term flow, vol, and momentum. Vol regime, breadth, momentum-vs-defensive leadership.",
  },
  {
    id: "cyclical",
    label: "Cyclical (3–6M)",
    shortLabel: "3–6M",
    weight: 0.3,
    description:
      "Sector rotation and business-cycle pulse. ISM PMI 50-line, discretionary vs staples, tech vs utilities.",
  },
  {
    id: "structural",
    label: "Structural (6–12M)",
    shortLabel: "6–12M",
    weight: 0.2,
    description:
      "Long-term trend overlay. SPX 10-month moving average and PMI directional trend.",
  },
] as const;

export const HORIZON_BY_ID: Record<Horizon, HorizonMeta> = HORIZONS.reduce(
  (acc, h) => {
    acc[h.id] = h;
    return acc;
  },
  {} as Record<Horizon, HorizonMeta>
);

/**
 * Map each composite-signal name (as emitted by `composeRegime` in
 * market-regime.ts) to its primary horizon. Names MUST match the
 * `name` field produced there exactly — keep this table in sync if
 * those strings ever change.
 *
 * ISM PMI is added by the regime route post-compose since it's a FRED
 * signal, not a Yahoo-derived ratio.
 */
export const SIGNAL_HORIZON: Record<string, Horizon> = {
  // ── Tactical (1–3M) ──
  "VIX Level": "tactical",
  "Breadth (RSP/SPY)": "tactical",
  "MTUM/USMV (Momentum/LowVol)": "tactical",
  // Built from the 20-day breadth change, so it reads on the tactical clock.
  "Breadth Divergence": "tactical",

  // ── Cyclical (3–6M) ──
  "XLY/XLP (Discretionary/Staples)": "cyclical",
  "XLK/XLU (Tech/Utilities)": "cyclical",
  "ISM PMI (50-line)": "cyclical",
  // HY spreads lead equity risk-off by weeks-to-months — a cyclical tell.
  "Credit Spreads (HY OAS)": "cyclical",

  // ── Structural (6–12M) ──
  "SPX 10-Month Trend": "structural",
  "ISM PMI Trend": "structural",
  "Yield Curve (10Y-2Y)": "structural",
};

export type HorizonComposite = {
  horizon: Horizon;
  label: string;
  shortLabel: string;
  weight: number;
  riskOn: number;
  riskOff: number;
  total: number; // signals evaluated in this horizon
  /** Continuous score in [-1, +1]: (riskOn - riskOff) / total. */
  score: number;
  label_: "Risk-On" | "Neutral" | "Risk-Off";
  signals: { name: string; direction: RegimeDirection; detail: string }[];
};

export type HorizonRollup = {
  byHorizon: Record<Horizon, HorizonComposite>;
  /**
   * Weighted overall score in [-1, +1] using HORIZONS weights.
   * NaN when no horizon has any signals (fresh blank cache).
   */
  weightedScore: number;
  weightedLabel: "Risk-On" | "Neutral" | "Risk-Off";
};

// ── Composition ──────────────────────────────────────────────────

/**
 * Label threshold on the weighted score (which lives in [-1, +1]). The
 * weighted score IS the canonical regime score (see composeRegime in
 * market-regime.ts) — a horizon-weighted net vote where every signal always
 * occupies a slot, neutral included, so the denominator can't shrink and
 * lower the bar on a quiet day.
 */
export const LABEL_THRESHOLD = 0.34;

export function classifyScore(score: number): "Risk-On" | "Neutral" | "Risk-Off" {
  // Continuous-score thresholds — chosen to roughly match the count-based
  // 66% threshold the flat composite used to use. With score = (on - off) / total:
  //   • +0.34 corresponds to "≥ 2/3 net risk-on" in any horizon
  //   • -0.34 to the symmetric risk-off case
  //   • everything in between is Neutral
  if (!isFinite(score)) return "Neutral";
  if (score >= LABEL_THRESHOLD) return "Risk-On";
  if (score <= -LABEL_THRESHOLD) return "Risk-Off";
  return "Neutral";
}

/** Map the [-1, +1] weighted score onto a 0..100 dial (50 = dead neutral).
 *  Rounded through 6 decimals first: the weighted sum accumulates float error
 *  (0.15 → 57.499999999999996), which would round the gauge DOWN to 57 while
 *  the per-signal breakdown adds to 57.5. The two must agree. */
export function scoreTo100(score: number): number | null {
  if (!isFinite(score)) return null;
  const raw = ((Math.max(-1, Math.min(1, score)) + 1) / 2) * 100;
  return Math.round(parseFloat(raw.toFixed(6)));
}

/**
 * Minimum number of individual signals that would have to change direction
 * for the weighted label to become `target`. Greedy: each signal's marginal
 * move on the weighted score is (horizonWeight / horizonTotal) per step, and
 * a signal can move up to two steps (risk-off → risk-on). We take the biggest
 * available moves first. Returns 0 when the label is already `target`, and
 * Infinity when no combination of flips could reach it (shouldn't happen with
 * signals present, but guards the empty case).
 */
export function signalsToFlip(
  rollup: HorizonRollup,
  target: "Risk-On" | "Neutral" | "Risk-Off"
): number {
  const current = rollup.weightedLabel;
  if (current === target) return 0;
  if (!isFinite(rollup.weightedScore)) return Infinity;

  // Effective per-horizon weight after the same re-normalisation rollupHorizons
  // applies (missing horizons don't count).
  let den = 0;
  for (const meta of HORIZONS) {
    const b = rollup.byHorizon[meta.id];
    if (b.total > 0 && isFinite(b.score)) den += meta.weight;
  }
  if (den <= 0) return Infinity;

  // Direction of travel needed and the boundary we must cross.
  // Risk-On → Neutral: score must fall below +T. Neutral → Risk-Off: ≤ -T.
  // Risk-Off → Neutral: score must rise above -T. Neutral → Risk-On: ≥ +T.
  let needed: number; // absolute score movement required
  let upward: boolean; // true = we need the score to rise
  const T = LABEL_THRESHOLD;
  const s = rollup.weightedScore;
  if (target === "Risk-On") { upward = true; needed = T - s; }
  else if (target === "Risk-Off") { upward = false; needed = s + T; }
  else if (current === "Risk-On") { upward = false; needed = s - T + 1e-9; }
  else { upward = true; needed = -T - s + 1e-9; }
  if (needed <= 0) return 0;

  // Each signal can contribute up to two "steps" of size w/total in the needed
  // direction (e.g. risk-off → risk-on = 2 steps upward). Collect every step.
  const steps: number[] = [];
  for (const meta of HORIZONS) {
    const b = rollup.byHorizon[meta.id];
    if (b.total === 0) continue;
    const unit = (meta.weight / den) / b.total;
    for (const sig of b.signals) {
      const room = upward
        ? sig.direction === "risk-on" ? 0 : sig.direction === "neutral" ? 1 : 2
        : sig.direction === "risk-off" ? 0 : sig.direction === "neutral" ? 1 : 2;
      if (room > 0) steps.push(unit * room);
    }
  }
  steps.sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < steps.length; i++) {
    acc += steps[i];
    if (acc >= needed) return i + 1;
  }
  return Infinity;
}

/**
 * Project the flat composite signals into per-horizon buckets and roll
 * them up into a weighted overall score. Signals whose names aren't in
 * SIGNAL_HORIZON are silently dropped — that's a defensive choice so a
 * mis-typed signal name doesn't poison the math (it'll just show 0/N
 * for the affected horizon, which is observable).
 */
export function rollupHorizons(
  signals: { name: string; direction: RegimeDirection; detail: string }[]
): HorizonRollup {
  const buckets: Record<Horizon, HorizonComposite> = {
    tactical: makeEmpty("tactical"),
    cyclical: makeEmpty("cyclical"),
    structural: makeEmpty("structural"),
  };

  for (const sig of signals) {
    const h = SIGNAL_HORIZON[sig.name];
    if (!h) continue;
    const b = buckets[h];
    b.signals.push(sig);
    b.total += 1;
    if (sig.direction === "risk-on") b.riskOn += 1;
    else if (sig.direction === "risk-off") b.riskOff += 1;
  }

  for (const h of ["tactical", "cyclical", "structural"] as const) {
    const b = buckets[h];
    b.score = b.total > 0 ? (b.riskOn - b.riskOff) / b.total : NaN;
    b.label_ = classifyScore(b.score);
  }

  // Weighted overall: only horizons that actually have signals contribute,
  // and we re-normalize by the contributing weight so a missing horizon
  // doesn't drag the score toward zero artificially.
  let weightedNum = 0;
  let weightedDen = 0;
  for (const meta of HORIZONS) {
    const b = buckets[meta.id];
    if (b.total === 0 || !isFinite(b.score)) continue;
    weightedNum += b.score * meta.weight;
    weightedDen += meta.weight;
  }
  const weightedScore = weightedDen > 0 ? weightedNum / weightedDen : NaN;
  const weightedLabel = classifyScore(weightedScore);

  return { byHorizon: buckets, weightedScore, weightedLabel };
}

function makeEmpty(id: Horizon): HorizonComposite {
  const meta = HORIZON_BY_ID[id];
  return {
    horizon: id,
    label: meta.label,
    shortLabel: meta.shortLabel,
    weight: meta.weight,
    riskOn: 0,
    riskOff: 0,
    total: 0,
    score: NaN,
    label_: "Neutral",
    signals: [],
  };
}

// ── Per-signal contributions (the dial breakdown) ─────────────────

export type SignalContribution = {
  name: string;
  direction: RegimeDirection;
  detail: string;
  horizon: Horizon;
  horizonLabel: string;
  horizonShort: string;
  /** Horizon weight after the same re-normalisation rollupHorizons applies. */
  horizonWeight: number;
  /** Dial points a SINGLE vote in this horizon is worth (always positive). */
  perSignalPoints: number;
  /** Signed contribution to the 0..100 dial; 0 for a neutral vote. */
  dialPoints: number;
};

/** Effective (re-normalised) weight per horizon — horizons with no signals
 *  don't dilute the rest, matching rollupHorizons' weightedScore. */
function effectiveWeights(rollup: HorizonRollup): Record<Horizon, number> {
  let den = 0;
  for (const meta of HORIZONS) {
    const b = rollup.byHorizon[meta.id];
    if (b.total > 0 && isFinite(b.score)) den += meta.weight;
  }
  const out = { tactical: 0, cyclical: 0, structural: 0 } as Record<Horizon, number>;
  if (den <= 0) return out;
  for (const meta of HORIZONS) {
    const b = rollup.byHorizon[meta.id];
    if (b.total > 0 && isFinite(b.score)) out[meta.id] = meta.weight / den;
  }
  return out;
}

/**
 * What each individual signal is worth on the 0..100 dial.
 *
 * The dial starts at 50 (every signal neutral) and each vote moves it by its
 * horizon's share divided by that horizon's signal count, scaled to dial
 * points. Summing `dialPoints` over every signal and adding 50 reproduces
 * `scoreTo100(weightedScore)` exactly — that identity is the point: the
 * breakdown shown to the PM has to add up to the number on the dial.
 *
 * Ordered by horizon (tactical → cyclical → structural), and within a horizon
 * by contribution, risk-on first.
 */
export function signalContributions(rollup: HorizonRollup): SignalContribution[] {
  const weights = effectiveWeights(rollup);
  const out: SignalContribution[] = [];
  for (const meta of HORIZONS) {
    const b = rollup.byHorizon[meta.id];
    if (b.total === 0) continue;
    const w = weights[meta.id];
    const perSignalPoints = (w / b.total) * 50;
    for (const sig of b.signals) {
      const sign = sig.direction === "risk-on" ? 1 : sig.direction === "risk-off" ? -1 : 0;
      out.push({
        name: sig.name,
        direction: sig.direction,
        detail: sig.detail,
        horizon: meta.id,
        horizonLabel: meta.label,
        horizonShort: meta.shortLabel,
        horizonWeight: w,
        perSignalPoints,
        dialPoints: sign * perSignalPoints,
      });
    }
  }
  return out.sort((a, b) => {
    const order: Horizon[] = ["tactical", "cyclical", "structural"];
    const d = order.indexOf(a.horizon) - order.indexOf(b.horizon);
    return d !== 0 ? d : b.dialPoints - a.dialPoints;
  });
}

export type FlipPlan = {
  target: "Risk-On" | "Neutral" | "Risk-Off";
  /** Fewest signals that would have to move. */
  count: number;
  /** Those signals, biggest mover first, with the dial points each would add. */
  signals: { name: string; dialPoints: number; steps: 1 | 2 }[];
};

/**
 * WHICH signals would move the label, not just how many — the greedy set
 * `signalsToFlip` counts, surfaced so the UI can name them. Returns null when
 * the label is already `target` or nothing could reach it.
 */
export function flipCandidates(
  rollup: HorizonRollup,
  target: "Risk-On" | "Neutral" | "Risk-Off"
): FlipPlan | null {
  const current = rollup.weightedLabel;
  if (current === target || !isFinite(rollup.weightedScore)) return null;

  const weights = effectiveWeights(rollup);
  const T = LABEL_THRESHOLD;
  const s = rollup.weightedScore;
  let needed: number;
  let upward: boolean;
  if (target === "Risk-On") { upward = true; needed = T - s; }
  else if (target === "Risk-Off") { upward = false; needed = s + T; }
  else if (current === "Risk-On") { upward = false; needed = s - T + 1e-9; }
  else { upward = true; needed = -T - s + 1e-9; }
  if (needed <= 0) return { target, count: 0, signals: [] };

  const moves: { name: string; score: number; steps: 1 | 2 }[] = [];
  for (const meta of HORIZONS) {
    const b = rollup.byHorizon[meta.id];
    if (b.total === 0) continue;
    const unit = weights[meta.id] / b.total;
    for (const sig of b.signals) {
      const room = upward
        ? sig.direction === "risk-on" ? 0 : sig.direction === "neutral" ? 1 : 2
        : sig.direction === "risk-off" ? 0 : sig.direction === "neutral" ? 1 : 2;
      if (room > 0) moves.push({ name: sig.name, score: unit * room, steps: room as 1 | 2 });
    }
  }
  moves.sort((a, b) => b.score - a.score);

  const chosen: FlipPlan["signals"] = [];
  let acc = 0;
  for (const m of moves) {
    acc += m.score;
    chosen.push({ name: m.name, dialPoints: m.score * 50 * (upward ? 1 : -1), steps: m.steps });
    if (acc >= needed) return { target, count: chosen.length, signals: chosen };
  }
  return null;
}
