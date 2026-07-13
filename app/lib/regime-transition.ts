/**
 * Regime-Transition gauge — Phase 02 of the forward-looking roadmap
 * (docs/forward-looking-roadmap.md).
 *
 * The market-regime engine (app/lib/market-regime.ts) classifies the CURRENT
 * regime (Risk-On / Neutral / Risk-Off). This module answers the forward
 * question the current label can't: "how close are we to FLIPPING, and which
 * signals are the early tells?"
 *
 * It is a HEURISTIC gauge, not a back-tested statistical probability. It reads
 * two things off the existing regime snapshot (no new data, no new Redis key —
 * a pure derivation of pm:market-regime):
 *   1. BOUNDARY PROXIMITY — how many signals must flip to change the composite
 *      label (the composite flips at a 66% super-majority threshold).
 *   2. SIGNAL MOMENTUM — which individual signals are trending toward the
 *      opposite side (breadth rolling over, VIX rising, a sector ratio losing
 *      leadership, ISM PMI trend deteriorating).
 *
 * Output leans the transition direction, scores the risk 0..90 (capped below
 * 100 to signal it is a gauge, not a certainty), and lists the specific tells.
 */

import type { MarketRegimeData } from "@/app/lib/market-regime";

export type TransitionMomentum = "deteriorating" | "improving";

export type TransitionTell = {
  name: string;
  momentum: TransitionMomentum; // toward Risk-Off | toward Risk-On
  detail: string;
};

export type RegimeTransition = {
  basedOnRegime: "Risk-On" | "Neutral" | "Risk-Off";
  regimeComputedAt: string; // computedAt of the source snapshot
  leaning: "toward Risk-Off" | "toward Neutral" | "toward Risk-On" | "stable";
  /** Heuristic transition-risk score, 0..90. Higher = closer to a flip. */
  score: number;
  likelihood: "Low" | "Watch" | "Elevated" | "High";
  /** Signals that must flip to change the composite label (boundary distance). */
  boundaryGap: number;
  tells: TransitionTell[];
  summary: string;
};

/**
 * Valence of a transition — decouples "which way + how big" from the raw lean,
 * so every surface (brief chip, attention panel, alerts) colors and routes it
 * the same way. The direction depends on BOTH the base regime and the lean:
 *   - cooling-hard: heading toward Risk-Off (a genuine risk to a long book).
 *   - cooling-soft: Risk-On easing toward Neutral (a mild de-risk — notable,
 *     not alarming).
 *   - warming-hard: heading toward Risk-On (a tailwind).
 *   - warming-soft: Risk-Off thawing toward Neutral (improving, not yet a flip).
 *   - none: stable / strengthening the current regime.
 * Derives purely from (basedOnRegime, leaning) so it also works on older stored
 * transitions that predate any explicit field.
 */
export type RegimeValence =
  | "cooling-hard"
  | "cooling-soft"
  | "warming-hard"
  | "warming-soft"
  | "none";

export function regimeValence(basedOnRegime: string, leaning: string): RegimeValence {
  if (leaning === "toward Risk-Off") return "cooling-hard";
  if (leaning === "toward Risk-On") return "warming-hard";
  if (leaning === "toward Neutral") return basedOnRegime === "Risk-On" ? "cooling-soft" : "warming-soft";
  return "none";
}

/** Deadband so tiny wiggles in a ratio don't register as momentum. */
const MOMENTUM_DEADBAND_PCT = 0.3;
const VIX_DEADBAND_PCT = 2;
const PMI_DEADBAND_ABS = 0.3;
const CREDIT_DEADBAND_BPS = 15;

/**
 * Horizon weighting — a position held for months shouldn't be re-rated on
 * tactical (day-to-day) noise. Tactical signals count less toward the
 * transition score; cyclical / structural / leading signals count full.
 */
const TACTICAL_SIGNALS = new Set(["VIX Level", "Breadth (RSP/SPY)", "MTUM/USMV (Momentum/LowVol)"]);
function horizonWeight(name: string): number {
  return TACTICAL_SIGNALS.has(name) ? 0.6 : 1.0;
}

type SignalMomentum = {
  name: string;
  currentDirection: "risk-on" | "neutral" | "risk-off";
  /** +1 improving (toward risk-on), -1 deteriorating (toward risk-off), 0 stable. */
  sign: -1 | 0 | 1;
  detail: string;
};

function signOf(x: number, deadband: number): -1 | 0 | 1 {
  if (x > deadband) return 1;
  if (x < -deadband) return -1;
  return 0;
}

/** Evaluate the momentum of each structured signal on the snapshot. */
function evaluateSignals(r: MarketRegimeData): SignalMomentum[] {
  const out: SignalMomentum[] = [];

  if (r.breadth) {
    out.push({
      name: "Breadth (RSP/SPY)",
      currentDirection: r.breadth.direction,
      sign: signOf(r.breadth.change20dPct, MOMENTUM_DEADBAND_PCT),
      detail: `20d ${r.breadth.change20dPct >= 0 ? "+" : ""}${r.breadth.change20dPct.toFixed(2)}%`,
    });
  }
  const ratioSignals: Array<[string, MarketRegimeData["sectorRatios"]["xlyXlp"]]> = [
    ["XLY/XLP (Discretionary/Staples)", r.sectorRatios.xlyXlp],
    ["XLK/XLU (Tech/Utilities)", r.sectorRatios.xlkXlu],
    ["MTUM/USMV (Momentum/LowVol)", r.sectorRatios.mtumUsmv],
  ];
  for (const [name, ratio] of ratioSignals) {
    if (!ratio) continue;
    out.push({
      name,
      currentDirection: ratio.direction,
      sign: signOf(ratio.change20dPct, MOMENTUM_DEADBAND_PCT),
      detail: `20d ${ratio.change20dPct >= 0 ? "+" : ""}${ratio.change20dPct.toFixed(2)}% · ${ratio.distancePct >= 0 ? "+" : ""}${ratio.distancePct.toFixed(1)}% vs 50D`,
    });
  }
  if (r.crossAsset.vix && typeof r.crossAsset.vix.change20dPct === "number") {
    // Rising VIX is deteriorating (toward risk-off), so invert the sign.
    const raw = signOf(r.crossAsset.vix.change20dPct, VIX_DEADBAND_PCT);
    out.push({
      name: "VIX Level",
      currentDirection: r.crossAsset.vix.direction,
      sign: (raw === 0 ? 0 : (-raw as -1 | 1)),
      detail: `${r.crossAsset.vix.price.toFixed(1)}, 20d ${r.crossAsset.vix.change20dPct >= 0 ? "+" : ""}${r.crossAsset.vix.change20dPct.toFixed(1)}%`,
    });
  }
  if (r.ismPmi) {
    out.push({
      name: "ISM PMI Trend",
      currentDirection: r.ismPmi.trend_direction,
      sign: signOf(r.ismPmi.change3mAbs, PMI_DEADBAND_ABS),
      detail: `${r.ismPmi.level.toFixed(1)}, ${r.ismPmi.change3mAbs >= 0 ? "+" : ""}${r.ismPmi.change3mAbs.toFixed(1)}pt 3M`,
    });
  }
  if (r.credit && typeof r.credit.change20dBps === "number") {
    // Widening HY spreads (positive change) is deteriorating (toward risk-off),
    // so invert the raw sign. 15bps deadband keeps noise out.
    const raw = signOf(r.credit.change20dBps, CREDIT_DEADBAND_BPS);
    out.push({
      name: "Credit Spreads (HY OAS)",
      currentDirection: r.credit.direction,
      sign: raw === 0 ? 0 : (-raw as -1 | 1),
      detail: `${r.credit.oasBps}bps, 20d ${r.credit.change20dBps >= 0 ? "+" : ""}${r.credit.change20dBps}bps`,
    });
  }
  if (r.breadthDivergence && r.breadthDivergence.direction !== "neutral") {
    const bd = r.breadthDivergence;
    out.push({
      name: "Breadth Divergence",
      currentDirection: bd.direction,
      sign: bd.direction === "risk-off" ? -1 : 1,
      detail: `price ${bd.priceDistancePct >= 0 ? "+" : ""}${bd.priceDistancePct.toFixed(1)}% vs 10M, breadth ${bd.breadthChange20dPct >= 0 ? "+" : ""}${bd.breadthChange20dPct.toFixed(1)}% 20d`,
    });
  }
  return out;
}

export function computeRegimeTransition(r: MarketRegimeData): RegimeTransition {
  const label = r.composite.label;
  const signals = r.composite.signals ?? [];
  const total = r.composite.total || signals.length;
  const riskOn = signals.filter((s) => s.direction === "risk-on").length;
  const riskOff = signals.filter((s) => s.direction === "risk-off").length;
  const threshold = total > 0 ? Math.ceil(total * 0.66) : 0;

  const momentum = evaluateSignals(r);
  const deteriorating = momentum.filter((m) => m.sign < 0); // pushing toward risk-off
  const improving = momentum.filter((m) => m.sign > 0); //     pushing toward risk-on

  // A transition is only meaningful when momentum pushes TOWARD LOSING the
  // current label (a flip) — not deeper into it. Define, per regime, which
  // momentum counts as "toward the flip" vs "strengthening the current regime":
  //   Risk-On  → flip is DOWN: deteriorating = toward flip, improving = strengthening.
  //   Risk-Off → flip is UP:   improving = toward flip, deteriorating = strengthening.
  //   Neutral  → whichever side dominates is the direction of travel.
  // The NEXT label off a non-neutral base is NEUTRAL, not the far pole — the
  // composite steps Risk-On → Neutral → Risk-Off, so a deteriorating Risk-On
  // regime is heading toward Neutral first (a de-risk), never straight to
  // Risk-Off. Only from Neutral does the anticipated pole become Risk-On/Off.
  let towardFlip: SignalMomentum[];
  let strengthening: SignalMomentum[];
  let anticipated: RegimeTransition["basedOnRegime"];
  if (label === "Risk-On") {
    towardFlip = deteriorating;
    strengthening = improving;
    anticipated = "Neutral";
  } else if (label === "Risk-Off") {
    towardFlip = improving;
    strengthening = deteriorating;
    anticipated = "Neutral";
  } else if (deteriorating.length > improving.length) {
    towardFlip = deteriorating;
    strengthening = improving;
    anticipated = "Risk-Off";
  } else if (improving.length > deteriorating.length) {
    towardFlip = improving;
    strengthening = deteriorating;
    anticipated = "Risk-On";
  } else {
    towardFlip = [];
    strengthening = deteriorating.concat(improving);
    anticipated = "Neutral";
  }

  // Are we genuinely leaning toward a flip, or just strengthening / calm?
  const leaningToFlip = towardFlip.length > strengthening.length && towardFlip.length > 0;
  let leaning: RegimeTransition["leaning"];
  if (!leaningToFlip) {
    leaning = "stable";
    anticipated = label; // strengthening/calm → no meaningful transition, no tilt
  } else {
    leaning =
      anticipated === "Risk-Off"
        ? "toward Risk-Off"
        : anticipated === "Risk-On"
        ? "toward Risk-On"
        : "toward Neutral";
  }

  // Boundary gap — how many signals from losing the current label.
  let boundaryGap: number;
  if (label === "Risk-On") boundaryGap = Math.max(1, riskOn - threshold + 1);
  else if (label === "Risk-Off") boundaryGap = Math.max(1, riskOff - threshold + 1);
  else boundaryGap = anticipated === "Risk-On" ? Math.max(1, threshold - riskOn) : Math.max(1, threshold - riskOff);

  // Tells = only the signals pushing toward a flip (empty when strengthening).
  const tells: TransitionTell[] = (leaningToFlip ? towardFlip : []).map((m) => ({
    name: m.name,
    momentum: m.sign < 0 ? "deteriorating" : "improving",
    detail: m.detail,
  }));

  // Heuristic score. Only elevates when momentum pushes toward a flip, and
  // REQUIRES corroboration — a single signal tops out at Elevated, not High.
  let score: number;
  if (leaningToFlip) {
    const base = boundaryGap === 1 ? 36 : boundaryGap === 2 ? 20 : boundaryGap === 3 ? 10 : 5;
    // Horizon-weighted corroboration: cyclical/structural/leading tells count
    // full, tactical tells count 0.6, so a flip driven by credit/breadth/ISM
    // scores higher than one driven by a VIX wiggle. High still needs ~2 tells.
    const weightedTells = tells.reduce((sum, t) => sum + horizonWeight(t.name), 0);
    const corroboration = Math.min(30, weightedTells * 12);
    score = base + corroboration + (r.spx10m && Math.abs(r.spx10m.distancePct) < 2 ? 6 : 0);
  } else {
    // Strengthening / calm — low transition risk (only mild fragility if the
    // current label itself is barely holding).
    score = boundaryGap === 1 ? 12 : 5;
  }
  score = Math.max(0, Math.min(90, Math.round(score)));

  const likelihood: RegimeTransition["likelihood"] =
    score >= 60 ? "High" : score >= 40 ? "Elevated" : score >= 20 ? "Watch" : "Low";

  // Direction-aware prose keyed off valence: warming = tailwind, cooling =
  // caution, the soft variants are moves toward Neutral (partial, not a full
  // flip). "Stable" is neutral.
  const valence = regimeValence(label, leaning);
  const sig = `${tells.length} signal${tells.length === 1 ? "" : "s"}`;
  const lk = likelihood.toLowerCase();
  let summary: string;
  if (!leaningToFlip) {
    summary = `${label} looks stable/strengthening — momentum isn't pushing toward a flip (transition risk ${lk}).`;
  } else if (valence === "warming-hard") {
    summary = `${label} and building ${leaning} — ${sig} pushing toward a flip, ${boundaryGap} from a label change (risk-on conviction ${lk}).`;
  } else if (valence === "warming-soft") {
    summary = `${label} but warming ${leaning} — ${sig} improving, ${boundaryGap} from shedding the ${label} label (${lk}).`;
  } else if (valence === "cooling-soft") {
    summary = `${label} but cooling ${leaning} — ${sig} easing, ${boundaryGap} from losing the ${label} label (de-risking ${lk}).`;
  } else {
    summary = `${label} but leaning ${leaning} — ${sig} pushing toward a flip, ${boundaryGap} from a label change (transition risk ${lk}).`;
  }

  return {
    basedOnRegime: label,
    regimeComputedAt: r.computedAt,
    leaning,
    score,
    likelihood,
    boundaryGap,
    tells,
    summary,
  };
}
