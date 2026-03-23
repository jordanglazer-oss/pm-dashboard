"use client";

import React from "react";
import type { MarketData } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";

type Props = {
  marketData: MarketData;
  hedgingAnalysis: string;
};

type SubScore = {
  label: string;
  score: number;
  tone: "red" | "amber" | "green";
  bullets: string[];
};

function vixSubScore(vix: number, termStructure: string): SubScore {
  let score: number;
  let tone: "red" | "amber" | "green";
  const bullets: string[] = [];

  if (vix >= 30) {
    score = 90;
    tone = "red";
    bullets.push(`VIX at ${vix} is well above the long-term average of ~19, indicating significant fear pricing in options markets`);
    bullets.push("Implied vol at this level suggests the market is pricing tail-risk events — hedges are expensive but warranted");
  } else if (vix >= 22) {
    score = 72;
    tone = "red";
    bullets.push(`VIX at ${vix} is elevated above the ~19 long-term average, signaling rising uncertainty`);
    bullets.push("Vol is high enough to justify adding protection, but not yet at panic levels where hedges become prohibitively expensive");
  } else if (vix >= 16) {
    score = 45;
    tone = "amber";
    bullets.push(`VIX at ${vix} is near the long-term average — no strong signal in either direction`);
    bullets.push("Hedging costs are moderate; consider strategic hedges but no urgency for tactical protection");
  } else {
    score = 20;
    tone = "green";
    bullets.push(`VIX at ${vix} indicates complacency — protection is cheap but may not feel necessary`);
    bullets.push("Low vol is historically the best time to buy hedges before the next spike");
  }

  if (termStructure === "Backwardation") {
    score = Math.min(100, score + 10);
    bullets.push("VIX term structure in backwardation — near-term fear exceeds longer-term, a classic stress signal");
  } else if (termStructure === "Contango") {
    bullets.push("VIX in contango — near-term vol is below longer-term, meaning markets expect elevated vol to persist but aren't in acute panic");
  }

  return { label: "Volatility", score, tone, bullets };
}

function creditSubScore(hyOas: number, igOas: number): SubScore {
  let score: number;
  let tone: "red" | "amber" | "green";
  const bullets: string[] = [];

  if (hyOas >= 400) {
    score = 95;
    tone = "red";
    bullets.push(`HY OAS at ${hyOas} bps is in distress territory — credit markets are pricing meaningful default risk`);
    bullets.push("Spreads at this level historically precede equity drawdowns of 15%+ if widening continues");
  } else if (hyOas >= 300) {
    score = 81;
    tone = "red";
    bullets.push(`HY OAS at ${hyOas} bps is widening past the stress threshold (~300 bps), signaling deteriorating risk appetite`);
    bullets.push("Credit leads equity — widening HY spreads typically foreshadow further equity weakness by 2-4 weeks");
  } else if (hyOas >= 200) {
    score = 50;
    tone = "amber";
    bullets.push(`HY OAS at ${hyOas} bps is in the normal range — no immediate credit stress signal`);
    bullets.push("Monitor for directional trend; stable spreads are neutral, but any acceleration higher is a red flag");
  } else {
    score = 20;
    tone = "green";
    bullets.push(`HY OAS at ${hyOas} bps is tight — credit markets are confident in the growth outlook`);
    bullets.push("Tight spreads reduce urgency for equity hedging but complacency can build quickly");
  }

  if (igOas >= 120) {
    bullets.push(`IG OAS at ~${igOas} bps is also elevated — stress is broad, not just in high-yield`);
  } else if (igOas >= 80) {
    bullets.push(`IG OAS at ~${igOas} bps is modestly wide — investment-grade credit is showing some stress but not acute`);
  } else {
    bullets.push(`IG OAS at ~${igOas} bps remains tight — stress is concentrated in high-yield, not broad-based`);
  }

  return { label: "Credit Spreads", score, tone, bullets };
}

function breadthSubScore(breadth: number): SubScore {
  let score: number;
  let tone: "red" | "amber" | "green";
  const bullets: string[] = [];

  if (breadth <= 35) {
    score = 95;
    tone = "red";
    bullets.push(`Only ${breadth}% of stocks above their 200-DMA — the majority of the market is in a downtrend`);
    bullets.push("Breadth this weak means index-level hedges may understate single-stock risk in the portfolio");
  } else if (breadth <= 50) {
    score = 86;
    tone = "red";
    bullets.push(`${breadth}% of stocks above 200-DMA is below the 50% threshold — more stocks are deteriorating than improving`);
    bullets.push("Weak breadth in a falling market increases the probability of a broader decline — the average stock is already in correction territory");
  } else if (breadth <= 65) {
    score = 50;
    tone = "amber";
    bullets.push(`${breadth}% above 200-DMA is neutral — participation is mixed but not alarming`);
    bullets.push("Watch for breadth divergence from index: if the index holds up while breadth fades, that's a warning");
  } else {
    score = 20;
    tone = "green";
    bullets.push(`${breadth}% above 200-DMA indicates healthy participation — the rally has broad support`);
    bullets.push("Strong breadth reduces urgency for portfolio-level hedges");
  }

  return { label: "Breadth", score, tone, bullets };
}

function sentimentSubScore(fearGreed: number, aaiiBullBear: number, putCall: number): SubScore {
  let score: number;
  let tone: "red" | "amber" | "green";
  const bullets: string[] = [];

  // Sentiment is contrarian for hedging — extreme fear means hedges may be less needed (washout),
  // but moderate fear without capitulation means risk remains
  if (fearGreed <= 15) {
    score = 40;
    tone = "amber";
    bullets.push(`Fear & Greed at ${fearGreed}/100 is near extreme fear — potential washout, which can mark interim bottoms`);
    bullets.push("Extreme pessimism reduces the urgency for new hedges (the crowd has already de-risked)");
  } else if (fearGreed <= 30) {
    score = 75;
    tone = "red";
    bullets.push(`Fear & Greed at ${fearGreed}/100 shows elevated fear but not capitulation — the market hasn't fully de-risked`);
    bullets.push("This is the danger zone: fearful enough to feel bad, but not washed out enough to call a durable low");
  } else if (fearGreed <= 55) {
    score = 50;
    tone = "amber";
    bullets.push(`Fear & Greed at ${fearGreed}/100 is neutral — no strong signal for hedging urgency`);
  } else {
    score = 30;
    tone = "green";
    bullets.push(`Fear & Greed at ${fearGreed}/100 shows complacency — good time to buy cheap hedges while the crowd is relaxed`);
  }

  if (aaiiBullBear <= -20) {
    bullets.push(`AAII spread at ${aaiiBullBear} is deeply bearish — retail has capitulated, which historically supports forward returns`);
  } else if (aaiiBullBear <= -5) {
    bullets.push(`AAII spread at ${aaiiBullBear} shows bears dominating, but not at extreme washout levels`);
  } else {
    bullets.push(`AAII spread at ${aaiiBullBear > 0 ? "+" : ""}${aaiiBullBear} shows balanced-to-bullish retail sentiment`);
  }

  if (putCall >= 1.0) {
    bullets.push(`Put/Call ratio at ${putCall} indicates elevated demand for downside protection — hedging demand is already high`);
  } else if (putCall >= 0.8) {
    bullets.push(`Put/Call ratio at ${putCall} is in the normal range — moderate hedging activity`);
  } else {
    bullets.push(`Put/Call ratio at ${putCall} is low — few are buying protection, making hedges relatively cheap`);
  }

  return { label: "Sentiment", score, tone, bullets };
}

function SubScoreCard({ sub }: { sub: SubScore }) {
  return (
    <div className="rounded-2xl border border-slate-100 bg-slate-50 p-4">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm font-medium text-slate-700">{sub.label}</span>
        <div className="flex items-center gap-2">
          <span className="text-2xl font-bold text-slate-900">{sub.score}</span>
          <span className="text-sm text-slate-400">/100</span>
        </div>
      </div>
      <div className="mb-3 h-2 rounded-full bg-slate-200 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${
            sub.tone === "red"
              ? "bg-red-400"
              : sub.tone === "amber"
              ? "bg-amber-400"
              : "bg-emerald-400"
          }`}
          style={{ width: `${sub.score}%` }}
        />
      </div>
      <ul className="space-y-1.5">
        {sub.bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-xs leading-relaxed text-slate-500">
            <span className="mt-1.5 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
            {b}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function HedgingIndicator({ marketData, hedgingAnalysis }: Props) {
  const vix = vixSubScore(marketData.vix, marketData.termStructure);
  const credit = creditSubScore(marketData.hyOas, marketData.igOas);
  const breadth = breadthSubScore(marketData.breadth);
  const sentiment = sentimentSubScore(
    marketData.fearGreed,
    marketData.aaiiBullBear,
    marketData.putCall
  );

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h3 className="text-2xl font-semibold">Hedging Indicator</h3>
          <p className="mt-2 text-slate-500">
            Current framework: add hedges when score &gt; 65
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <SignalPill tone="red">
            Current score: {marketData.hedgeScore}/100
          </SignalPill>
          <SignalPill tone="amber">
            Timing: {marketData.hedgeTiming}
          </SignalPill>
        </div>
      </div>

      <p className="mt-4 text-lg leading-8 text-slate-600">
        {hedgingAnalysis}
      </p>

      <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SubScoreCard sub={vix} />
        <SubScoreCard sub={credit} />
        <SubScoreCard sub={breadth} />
        <SubScoreCard sub={sentiment} />
      </div>
    </section>
  );
}
