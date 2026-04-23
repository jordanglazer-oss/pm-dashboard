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

  // ── Cyclical (3–6M) ──
  "XLY/XLP (Discretionary/Staples)": "cyclical",
  "XLK/XLU (Tech/Utilities)": "cyclical",
  "ISM PMI (50-line)": "cyclical",

  // ── Structural (6–12M) ──
  "SPX 10-Month Trend": "structural",
  "ISM PMI Trend": "structural",
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

function classifyScore(score: number): "Risk-On" | "Neutral" | "Risk-Off" {
  // Continuous-score thresholds — chosen to roughly match the count-based
  // 66% threshold the flat composite uses. With score = (on - off) / total:
  //   • +0.34 corresponds to "≥ 2/3 net risk-on" in any horizon
  //   • -0.34 to the symmetric risk-off case
  //   • everything in between is Neutral
  if (!isFinite(score)) return "Neutral";
  if (score >= 0.34) return "Risk-On";
  if (score <= -0.34) return "Risk-Off";
  return "Neutral";
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
