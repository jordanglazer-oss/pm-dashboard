"use client";

import React from "react";
import type { MarketData } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";

type Props = {
  marketData: MarketData;
  aaiiBull?: number;
  aaiiNeutral?: number;
  aaiiBear?: number;
};

function fearGreedLabel(value: number): string {
  if (value <= 10) return "Extreme Fear";
  if (value <= 25) return "Fear";
  if (value <= 45) return "Neutral-Bearish";
  if (value <= 55) return "Neutral";
  if (value <= 75) return "Greed";
  return "Extreme Greed";
}

function fearGreedContrarian(value: number): {
  signal: string;
  tone: "red" | "amber" | "green";
  detail: string;
} {
  if (value <= 15)
    return {
      signal: "Contrarian Bullish",
      tone: "green",
      detail:
        "Extreme fear readings historically precede strong forward returns. Panic selling creates opportunity for disciplined PMs willing to add risk when others capitulate.",
    };
  if (value <= 30)
    return {
      signal: "Leaning Bullish",
      tone: "green",
      detail:
        "Fear is elevated but not extreme. The crowd is cautious, which reduces the probability of a further severe drawdown from current levels.",
    };
  if (value <= 55)
    return {
      signal: "Neutral",
      tone: "amber",
      detail:
        "Sentiment is balanced. No strong contrarian signal in either direction.",
    };
  if (value <= 75)
    return {
      signal: "Leaning Bearish",
      tone: "amber",
      detail:
        "Complacency is building. Consider tightening stops and reducing marginal risk.",
    };
  return {
    signal: "Contrarian Bearish",
    tone: "red",
    detail:
      "Extreme greed is a reliable warning sign. This is where PMs should be raising cash and adding hedges.",
  };
}

function aaiiBullBearContrarian(spread: number): {
  signal: string;
  tone: "red" | "amber" | "green";
  detail: string;
} {
  if (spread <= -20)
    return {
      signal: "Contrarian Bullish",
      tone: "green",
      detail:
        "Retail investors are deeply bearish. Historically, AAII spreads below -20 have preceded above-average 6-12 month returns.",
    };
  if (spread <= -5)
    return {
      signal: "Leaning Bullish",
      tone: "green",
      detail:
        "Bears outnumber bulls by a meaningful margin. Incrementally supportive for forward returns.",
    };
  if (spread <= 15)
    return {
      signal: "Neutral",
      tone: "amber",
      detail:
        "No actionable contrarian signal from the AAII survey at current levels.",
    };
  if (spread <= 30)
    return {
      signal: "Leaning Bearish",
      tone: "amber",
      detail:
        "Bulls are gaining confidence. Elevated bullish sentiment tends to precede below-average returns.",
    };
  return {
    signal: "Contrarian Bearish",
    tone: "red",
    detail:
      "Retail euphoria is extreme. AAII spreads above +30 are rare and have historically marked intermediate tops.",
  };
}

// Contrarian rating based on combined signals
function overallContrarianRating(fg: number, spread: number): { label: string; tone: "red" | "amber" | "green" } {
  const fgSignal = fg <= 15 ? 2 : fg <= 30 ? 1 : fg <= 55 ? 0 : fg <= 75 ? -1 : -2;
  const aaiiSignal = spread <= -20 ? 2 : spread <= -5 ? 1 : spread <= 15 ? 0 : spread <= 30 ? -1 : -2;
  const combined = fgSignal + aaiiSignal;

  if (combined >= 3) return { label: "Strong Buy", tone: "green" };
  if (combined >= 1) return { label: "Leaning Bullish", tone: "green" };
  if (combined >= -1) return { label: "Neutral", tone: "amber" };
  if (combined >= -3) return { label: "Leaning Bearish", tone: "amber" };
  return { label: "Strong Sell Signal", tone: "red" };
}

export function SentimentGauges({ marketData, aaiiBull = 30, aaiiNeutral = 17, aaiiBear = 52 }: Props) {
  const fgData = fearGreedContrarian(marketData.fearGreed);
  const aaiiData = aaiiBullBearContrarian(marketData.aaiiBullBear);
  const overall = overallContrarianRating(marketData.fearGreed, marketData.aaiiBullBear);
  const fgLabel = fearGreedLabel(marketData.fearGreed);

  // Color for the donut gauge
  const fgColor =
    marketData.fearGreed <= 25 ? "#ef4444" : marketData.fearGreed <= 50 ? "#f59e0b" : "#22c55e";

  // SVG donut for F&G
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const pct = marketData.fearGreed / 100;
  const dashOffset = circumference * (1 - pct);

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div className="flex items-center gap-2">
          <span className="text-xl">🎯</span>
          <h3 className="text-2xl font-semibold">Contrarian Sentiment</h3>
          <SignalPill tone="amber">COUNTER-SIGNAL</SignalPill>
        </div>
        <SignalPill tone={overall.tone}>{overall.label}</SignalPill>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* CNN Fear & Greed */}
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
          <div className="text-sm font-semibold text-slate-500 mb-4">CNN Fear & Greed</div>
          <div className="flex items-center gap-6">
            <svg width="100" height="100" viewBox="0 0 100 100" className="shrink-0">
              <circle cx="50" cy="50" r={radius} fill="none" stroke="#e2e8f0" strokeWidth="8" />
              <circle
                cx="50"
                cy="50"
                r={radius}
                fill="none"
                stroke={fgColor}
                strokeWidth="8"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={dashOffset}
                transform="rotate(-90 50 50)"
              />
              <text x="50" y="46" textAnchor="middle" className="text-2xl font-bold" fill="#1e293b" fontSize="22">
                {marketData.fearGreed}
              </text>
              <text x="50" y="62" textAnchor="middle" fill="#94a3b8" fontSize="10">
                /100
              </text>
            </svg>
            <div>
              <div className="text-xl font-semibold" style={{ color: fgColor }}>{fgLabel}</div>
              <p className="mt-2 text-sm text-slate-500 leading-relaxed">{fgData.detail}</p>
            </div>
          </div>
        </div>

        {/* AAII Sentiment */}
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
          <div className="text-sm font-semibold text-slate-500 mb-4">AAII Sentiment Survey</div>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <span className="w-16 text-sm text-slate-500">Bullish</span>
              <div className="flex-1 h-4 rounded-full bg-slate-200 overflow-hidden">
                <div className="h-full rounded-full bg-emerald-500" style={{ width: `${aaiiBull}%` }} />
              </div>
              <span className="w-14 text-right font-mono text-sm font-semibold">{aaiiBull.toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 text-sm text-slate-500">Neutral</span>
              <div className="flex-1 h-4 rounded-full bg-slate-200 overflow-hidden">
                <div className="h-full rounded-full bg-amber-400" style={{ width: `${aaiiNeutral}%` }} />
              </div>
              <span className="w-14 text-right font-mono text-sm font-semibold">{aaiiNeutral.toFixed(1)}%</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-16 text-sm text-slate-500">Bearish</span>
              <div className="flex-1 h-4 rounded-full bg-slate-200 overflow-hidden">
                <div className="h-full rounded-full bg-red-500" style={{ width: `${aaiiBear}%` }} />
              </div>
              <span className="w-14 text-right font-mono text-sm font-semibold">{aaiiBear.toFixed(1)}%</span>
            </div>
            <div className="text-right text-sm text-slate-400">
              Bull-Bear Spread: <strong className="text-slate-700">{marketData.aaiiBullBear > 0 ? "+" : ""}{marketData.aaiiBullBear.toFixed(1)}%</strong>
            </div>
          </div>
          <p className="mt-3 text-sm text-slate-500 leading-relaxed">{aaiiData.detail}</p>
        </div>
      </div>
    </section>
  );
}
