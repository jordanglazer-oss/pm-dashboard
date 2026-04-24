"use client";

/**
 * Hedging Indicator — when (and at what tenor) to add SPY protective puts.
 *
 * SCOPE & CONSTRAINTS (read these before changing the math):
 *   • SPY only. Single-name puts and index alternatives are out of scope.
 *   • PROTECTIVE puts only. We do not speculate; every recommendation here
 *     assumes the put is paired against existing equity exposure.
 *   • Strike band: ATM to 10% OTM. The component does not surface a strike
 *     selector — the verdict text describes the band; the user picks the
 *     specific strike at execution.
 *   • Tenor band: 2–9 months. NO weeklies (premium decay too fast on a
 *     low-conviction near-term hedge), NO LEAPS (>9M tenor too disconnected
 *     from the regime read that justified the hedge in the first place).
 *
 * HORIZON MAPPING (Phase 4):
 *   The PM's hedging horizon is selectable so the recommendation language
 *   matches the actual contract being considered. Mapping:
 *     • Tactical   (1–3M)  → 2–3 month tenor (monthly contracts)
 *     • Cyclical   (3–6M)  → 3–6 month tenor (quarterly) — DEFAULT
 *     • Structural (6–12M) → 6–9 month tenor (capped at 9M; no LEAPS)
 *
 *   Cyclical is the default because the 3–6M window is the meat of the
 *   2–9M allowable band and matches the typical hedging cadence.
 *
 *   When the deterministic horizon composite for the selected horizon is
 *   available (passed in via the optional `horizons` prop sourced from
 *   pm:market-regime), it modulates the verdict: a Risk-Off composite for
 *   the selected horizon biases toward "add now even if vol is mid",
 *   while a Risk-On composite biases toward "skip — protection is wasted
 *   premium when the horizon read is constructive". Without horizon data
 *   the component falls back to the original VIX/term-structure/sentiment
 *   verdict logic so old briefs and stale caches keep rendering.
 */

import React, { useState } from "react";
import { SignalPill } from "./SignalPill";
import { HORIZONS, type Horizon, type HorizonRollup } from "@/app/lib/horizons";

type Props = {
  vix: number;
  termStructure: string;
  fearGreed: number;
  hedgingAnalysis: string;
  /** Optional — when present, drives the horizon selector and modulates the
   *  verdict. Sourced from pm:market-regime via the parent component. */
  horizons?: HorizonRollup;
};

type HedgeFactor = {
  label: string;
  sublabel: string;
  value: string;
  optimal: boolean;
};

/** Tenor band per horizon — see header comment for rationale. */
const TENOR_BY_HORIZON: Record<Horizon, { label: string; contractCadence: string }> = {
  tactical: { label: "2–3 month", contractCadence: "monthly contracts" },
  cyclical: { label: "3–6 month", contractCadence: "quarterly contracts" },
  structural: { label: "6–9 month", contractCadence: "9-month max — no LEAPS" },
};

function assessPutCost(vix: number): HedgeFactor {
  if (vix <= 14) {
    return { label: "PUT COST ENV.", sublabel: "Cheap", value: `Cheap (VIX ${vix})`, optimal: true };
  }
  if (vix <= 18) {
    return { label: "PUT COST ENV.", sublabel: "Moderate", value: `Moderate (VIX ${vix})`, optimal: true };
  }
  if (vix <= 24) {
    return { label: "PUT COST ENV.", sublabel: "Elevated", value: `Elevated (VIX ${vix})`, optimal: false };
  }
  return { label: "PUT COST ENV.", sublabel: "Expensive", value: `Expensive (VIX ${vix})`, optimal: false };
}

function assessVixContext(vix: number, termStructure: string): HedgeFactor {
  const inBackwardation = termStructure === "Backwardation";
  if (vix <= 16) {
    return {
      label: "VIX CONTEXT",
      sublabel: "Low vol",
      value: "Low vol\u2014insurance cheap, buy now",
      optimal: true,
    };
  }
  if (vix <= 22) {
    return {
      label: "VIX CONTEXT",
      sublabel: "Moderate",
      value: inBackwardation
        ? "Moderate but backwardation\u2014near-term stress priced in"
        : "Moderate\u2014hedges fairly priced",
      optimal: !inBackwardation,
    };
  }
  return {
    label: "VIX CONTEXT",
    sublabel: "Elevated",
    value: inBackwardation
      ? "Elevated\u2014insurance already priced in"
      : "Elevated in contango\u2014costly but persistent vol expected",
    optimal: false,
  };
}

function assessSentiment(fearGreed: number): HedgeFactor {
  if (fearGreed >= 65) {
    return { label: "SENTIMENT", sublabel: "Greedy", value: "Greedy complacency\u2014cheap protection available", optimal: true };
  }
  if (fearGreed >= 45) {
    return { label: "SENTIMENT", sublabel: "Neutral", value: "Neutral sentiment\u2014moderate hedging demand", optimal: true };
  }
  if (fearGreed >= 25) {
    return { label: "SENTIMENT", sublabel: "Fearful", value: "Fear elevated\u2014hedging demand already high", optimal: false };
  }
  return { label: "SENTIMENT", sublabel: "Extreme fear", value: "Extreme fear\u2014not greedy complacency", optimal: false };
}

/**
 * Verdict composes the three vol/sentiment factors with the selected
 * horizon's deterministic composite. The horizon score acts as a tilt:
 *   • Risk-Off horizon  → bias toward ADD (even at mid-vol)
 *   • Risk-On horizon   → bias toward SKIP (don't burn premium when the
 *                          horizon read is constructive)
 *   • Neutral / no data → fall back to pure factor-count logic
 */
function getHedgingVerdict(
  factors: HedgeFactor[],
  horizonLabel: string,
  tenorLabel: string,
  horizonComposite: "Risk-On" | "Neutral" | "Risk-Off" | null
): { label: string; tone: "green" | "amber" | "red"; explanation: string } {
  const optimalCount = factors.filter((f) => f.optimal).length;

  // Horizon tilt — a strong directional read on the selected horizon
  // overrides the factor-count default in the obvious cases.
  if (horizonComposite === "Risk-Off") {
    return {
      label: "ADD",
      tone: "amber",
      explanation: `${horizonLabel} composite reads Risk-Off — protection earns its premium here. Lean into ${tenorLabel} SPY puts (ATM to 10% OTM); accept paying up if vol is elevated, since the regime read justifies it. Stagger entries rather than committing the full sleeve at one strike.`,
    };
  }
  if (horizonComposite === "Risk-On" && optimalCount <= 1) {
    return {
      label: "SKIP",
      tone: "red",
      explanation: `${horizonLabel} composite reads Risk-On and vol/sentiment factors don't justify the bleed. Skip new ${tenorLabel} SPY puts — premium spent here is dead weight while the horizon trend is intact. Re-evaluate if the composite flips Neutral or if VIX dips into the cheap band.`,
    };
  }

  // Default factor-count logic, with horizon labeling so the PM still
  // knows which contract band the verdict applies to.
  if (optimalCount === 3) {
    return {
      label: "OPTIMAL",
      tone: "green",
      explanation: `Puts are cheap, vol is low, and sentiment is complacent. This is the ideal window to add ${tenorLabel} SPY puts (ATM to 10% OTM) ahead of the next vol spike. Pair with ${horizonLabel} thesis for sizing.`,
    };
  }
  if (optimalCount === 2) {
    return {
      label: "FAVORABLE",
      tone: "green",
      explanation: `Most conditions favor adding ${tenorLabel} SPY puts. Scale into ATM-to-10%-OTM strikes at current levels — don't wait for a perfect setup. ${horizonLabel} read confirms the timing.`,
    };
  }
  if (optimalCount === 1) {
    return {
      label: "MIXED",
      tone: "amber",
      explanation: `Hedging conditions are mixed for ${tenorLabel} ${horizonLabel.toLowerCase()} puts. Premium may be elevated or the market has already de-risked. Consider waiting for VIX to dip back into the cheap band before initiating.`,
    };
  }
  return {
    label: "SKIP",
    tone: "red",
    explanation: `Skip new ${tenorLabel} SPY puts. VIX is elevated meaning protection is costly, and a fear-driven setup means you'd be buying high on insurance. Wait for complacency to return before initiating ${horizonLabel.toLowerCase()} hedges.`,
  };
}

export function HedgingIndicator({ vix, termStructure, fearGreed, hedgingAnalysis, horizons }: Props) {
  // Cyclical (3–6M) is the default because it sits squarely in the middle
  // of the allowed 2–9M tenor band and matches the typical hedge cadence.
  // The user can flip to tactical (2–3M) or structural (6–9M) without
  // losing the rest of the tile state.
  const [selectedHorizon, setSelectedHorizon] = useState<Horizon>("cyclical");
  const tenor = TENOR_BY_HORIZON[selectedHorizon];
  const horizonMeta = HORIZONS.find((h) => h.id === selectedHorizon)!;
  const horizonBucket = horizons?.byHorizon[selectedHorizon];
  const horizonComposite = horizonBucket && horizonBucket.total > 0 ? horizonBucket.label_ : null;

  const putCost = assessPutCost(vix);
  const vixContext = assessVixContext(vix, termStructure);
  const sentiment = assessSentiment(fearGreed);
  const factors = [putCost, vixContext, sentiment];
  const verdict = getHedgingVerdict(factors, horizonMeta.label, tenor.label, horizonComposite);

  // Prefer the AI's per-brief hedging analysis when present (it's already
  // tailored to current premiums + horizon stance via the brief prompt).
  // Fall back to the deterministic verdict explanation otherwise.
  const analysis = hedgingAnalysis || verdict.explanation;

  const compositeBadgeTone: "green" | "amber" | "red" = !horizonComposite
    ? "amber"
    : horizonComposite === "Risk-On"
    ? "green"
    : horizonComposite === "Risk-Off"
    ? "red"
    : "amber";

  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Hedging Window (SPY Puts)</h3>
        <SignalPill tone={verdict.tone}>{verdict.label}</SignalPill>
      </div>

      {/* Horizon selector — three-button segmented control. Each button
          shows the horizon's short label plus the implied tenor band so
          the PM sees the contract maturity inline before choosing. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Horizon</span>
        <div className="inline-flex rounded-full border border-slate-200 bg-slate-50 p-0.5">
          {HORIZONS.map((h) => {
            const active = h.id === selectedHorizon;
            return (
              <button
                key={h.id}
                type="button"
                onClick={() => setSelectedHorizon(h.id)}
                className={`rounded-full px-3 py-1 text-[11px] font-semibold transition-colors ${
                  active
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-slate-600 hover:text-slate-900"
                }`}
                title={`${h.label} → ${TENOR_BY_HORIZON[h.id].label} SPY puts`}
              >
                {h.shortLabel}
                <span className="ml-1 opacity-60">· {TENOR_BY_HORIZON[h.id].label}</span>
              </button>
            );
          })}
        </div>
        {horizonComposite && horizonBucket && (
          <SignalPill tone={compositeBadgeTone}>
            {horizonComposite}{" "}
            <span className="font-mono opacity-70">
              {horizonBucket.riskOn}-{horizonBucket.riskOff}/{horizonBucket.total}
            </span>
          </SignalPill>
        )}
        {!horizonComposite && (
          <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] text-slate-400">
            no horizon signals
          </span>
        )}
      </div>

      {/* Tenor reminder strip — keeps the strike + cadence rules visible
          so the verdict text doesn't have to repeat them every render. */}
      <div className="mt-2 text-[11px] text-slate-500">
        Strikes: <span className="font-semibold text-slate-700">ATM to 10% OTM</span> ·{" "}
        Tenor: <span className="font-semibold text-slate-700">{tenor.label}</span>{" "}
        <span className="opacity-70">({tenor.contractCadence})</span>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-3">
        {factors.map((f) => (
          <div
            key={f.label}
            className={`rounded-xl border p-3 ${
              f.optimal
                ? "border-emerald-200 bg-emerald-50/40"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
              {f.label}
            </div>
            <div className="mt-1 text-sm font-medium text-slate-900 leading-snug">
              {f.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 rounded-xl border-l-4 border-slate-300 bg-slate-50 p-3">
        <p className="text-sm leading-6 text-slate-700">{analysis}</p>
      </div>
    </section>
  );
}
