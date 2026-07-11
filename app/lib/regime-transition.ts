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
  leaning: "toward Risk-Off" | "toward Risk-On" | "stable";
  /** Heuristic transition-risk score, 0..90. Higher = closer to a flip. */
  score: number;
  likelihood: "Low" | "Watch" | "Elevated" | "High";
  /** Signals that must flip to change the composite label (boundary distance). */
  boundaryGap: number;
  tells: TransitionTell[];
  summary: string;
};

/** Deadband so tiny wiggles in a ratio don't register as momentum. */
const MOMENTUM_DEADBAND_PCT = 0.3;
const VIX_DEADBAND_PCT = 2;
const PMI_DEADBAND_ABS = 0.3;

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
  // Deterioration = pressure toward risk-off; improvement = toward risk-on.
  const deteriorating = momentum.filter((m) => m.sign < 0);
  const improving = momentum.filter((m) => m.sign > 0);

  // Net leaning. From Risk-Off, "improving" is the recovery direction.
  let leaning: RegimeTransition["leaning"];
  if (deteriorating.length > improving.length) leaning = "toward Risk-Off";
  else if (improving.length > deteriorating.length) leaning = "toward Risk-On";
  else leaning = "stable";

  // Boundary gap — how many signals must flip to change the label.
  let boundaryGap: number;
  if (label === "Risk-On") boundaryGap = Math.max(1, riskOn - threshold + 1);
  else if (label === "Risk-Off") boundaryGap = Math.max(1, riskOff - threshold + 1);
  else {
    // Neutral — distance to whichever side we're leaning.
    const gapToOff = Math.max(1, threshold - riskOff);
    const gapToOn = Math.max(1, threshold - riskOn);
    boundaryGap = leaning === "toward Risk-On" ? gapToOn : gapToOff;
  }

  // The tells that matter are the ones pushing in the leaning direction and
  // able to flip (a risk-on/neutral signal deteriorating; a risk-off/neutral
  // signal improving). Stable regimes surface the stronger side for context.
  const leaningSign = leaning === "toward Risk-Off" ? -1 : leaning === "toward Risk-On" ? 1 : 0;
  const tellSource =
    leaningSign < 0 ? deteriorating : leaningSign > 0 ? improving : deteriorating.concat(improving);
  const tells: TransitionTell[] = tellSource
    .filter((m) =>
      leaningSign < 0
        ? m.currentDirection !== "risk-off"
        : leaningSign > 0
        ? m.currentDirection !== "risk-on"
        : true,
    )
    .map((m) => ({
      name: m.name,
      momentum: m.sign < 0 ? "deteriorating" : "improving",
      detail: m.detail,
    }));

  // Heuristic score. Boundary proximity is the backbone; momentum adds
  // pressure; a near-the-line SPX trend adds fragility. Capped at 90.
  let score = boundaryGap === 1 ? 55 : boundaryGap === 2 ? 30 : boundaryGap === 3 ? 12 : 5;
  score += Math.min(36, tells.length * 9);
  if (r.spx10m && Math.abs(r.spx10m.distancePct) < 2) score += 8;
  if (leaning === "stable") score = Math.round(score * 0.5); // no directional pressure
  score = Math.max(0, Math.min(90, Math.round(score)));

  const likelihood: RegimeTransition["likelihood"] =
    score >= 60 ? "High" : score >= 40 ? "Elevated" : score >= 20 ? "Watch" : "Low";

  const summary =
    leaning === "stable"
      ? `${label} looks stable — no clear directional pressure in the underlying signals (transition risk ${likelihood.toLowerCase()}).`
      : `${label} is leaning ${leaning} — ${tells.length} signal${tells.length === 1 ? "" : "s"} ${leaningSign < 0 ? "deteriorating" : "improving"}, ${boundaryGap} signal${boundaryGap === 1 ? "" : "s"} from a label change (transition risk ${likelihood.toLowerCase()}).`;

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
