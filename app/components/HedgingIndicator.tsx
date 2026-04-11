"use client";

import React from "react";
import { SignalPill } from "./SignalPill";

type Props = {
  vix: number;
  termStructure: string;
  fearGreed: number;
  hedgingAnalysis: string;
};

type HedgeFactor = {
  label: string;
  sublabel: string;
  value: string;
  optimal: boolean;
};

function assessPutCost(vix: number): HedgeFactor {
  if (vix <= 14) {
    return {
      label: "PUT COST ENV.",
      sublabel: "Cheap",
      value: `Cheap (VIX ${vix})`,
      optimal: true,
    };
  }
  if (vix <= 18) {
    return {
      label: "PUT COST ENV.",
      sublabel: "Moderate",
      value: `Moderate (VIX ${vix})`,
      optimal: true,
    };
  }
  if (vix <= 24) {
    return {
      label: "PUT COST ENV.",
      sublabel: "Elevated",
      value: `Elevated (VIX ${vix})`,
      optimal: false,
    };
  }
  return {
    label: "PUT COST ENV.",
    sublabel: "Expensive",
    value: `Expensive (VIX ${vix})`,
    optimal: false,
  };
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
    return {
      label: "SENTIMENT",
      sublabel: "Greedy",
      value: "Greedy complacency\u2014cheap protection available",
      optimal: true,
    };
  }
  if (fearGreed >= 45) {
    return {
      label: "SENTIMENT",
      sublabel: "Neutral",
      value: "Neutral sentiment\u2014moderate hedging demand",
      optimal: true,
    };
  }
  if (fearGreed >= 25) {
    return {
      label: "SENTIMENT",
      sublabel: "Fearful",
      value: "Fear elevated\u2014hedging demand already high",
      optimal: false,
    };
  }
  return {
    label: "SENTIMENT",
    sublabel: "Extreme fear",
    value: "Extreme fear\u2014not greedy complacency",
    optimal: false,
  };
}

function getHedgingVerdict(factors: HedgeFactor[]): {
  label: string;
  tone: "green" | "amber" | "red";
  explanation: string;
} {
  const optimalCount = factors.filter((f) => f.optimal).length;
  if (optimalCount === 3) {
    return {
      label: "OPTIMAL",
      tone: "green",
      explanation:
        "Puts are cheap, vol is low, and sentiment is complacent. This is the ideal window to add SPY put protection before the next volatility spike.",
    };
  }
  if (optimalCount === 2) {
    return {
      label: "FAVORABLE",
      tone: "green",
      explanation:
        "Most conditions favor adding hedges. Consider scaling into SPY puts at current levels\u2014don't wait for perfect setup.",
    };
  }
  if (optimalCount === 1) {
    return {
      label: "NOT OPTIMAL",
      tone: "amber",
      explanation:
        "Hedging conditions are mixed. Puts may be overpriced or the market has already de-risked. Consider collar strategies or waiting for better entry.",
    };
  }
  return {
    label: "NOT OPTIMAL",
    tone: "red",
    explanation:
      "Skip new SPY puts. VIX is elevated meaning puts are costly. Current fear-driven setup means adding puts here is buying high on protection. Wait for complacency to return.",
  };
}

export function HedgingIndicator({ vix, termStructure, fearGreed, hedgingAnalysis }: Props) {
  const putCost = assessPutCost(vix);
  const vixContext = assessVixContext(vix, termStructure);
  const sentiment = assessSentiment(fearGreed);

  const factors = [putCost, vixContext, sentiment];
  const verdict = getHedgingVerdict(factors);

  const analysis = hedgingAnalysis || verdict.explanation;

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h3 className="text-2xl font-semibold">Hedging Window (SPY Puts)</h3>
        <SignalPill tone={verdict.tone}>{verdict.label}</SignalPill>
      </div>

      <div className="mt-5 grid gap-4 md:grid-cols-3">
        {factors.map((f) => (
          <div
            key={f.label}
            className={`rounded-2xl border p-4 ${
              f.optimal
                ? "border-emerald-200 bg-emerald-50/40"
                : "border-slate-200 bg-slate-50"
            }`}
          >
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
              {f.label}
            </div>
            <div className="mt-2 text-lg font-medium text-slate-900">
              {f.value}
            </div>
          </div>
        ))}
      </div>

      <div className="mt-5 rounded-2xl border-l-4 border-slate-300 bg-slate-50 p-4">
        <p className="text-lg leading-8 text-slate-700">{analysis}</p>
      </div>
    </section>
  );
}
