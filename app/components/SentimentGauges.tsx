"use client";

import React from "react";
import type { MarketData } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";

type Props = {
  marketData: MarketData;
  aaiiBull?: number;
  aaiiNeutral?: number;
  aaiiBear?: number;
  contrarianAnalysis?: string;
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

// Contrarian rating based on all 4 indicators (range -8 to +8)
export function overallContrarianRating(fg: number, spread: number, spOsc: number = 0, putCall: number = 0.85): { label: string; tone: "red" | "amber" | "green" } {
  const fgSignal = fg <= 15 ? 2 : fg <= 30 ? 1 : fg <= 55 ? 0 : fg <= 75 ? -1 : -2;
  const aaiiSignal = spread <= -20 ? 2 : spread <= -5 ? 1 : spread <= 15 ? 0 : spread <= 30 ? -1 : -2;
  const oscSignal = spOsc <= -4 ? 2 : spOsc <= -2 ? 1 : spOsc <= 2 ? 0 : spOsc <= 4 ? -1 : -2;
  const pcSignal = putCall >= 1.2 ? 2 : putCall >= 1.0 ? 1 : putCall >= 0.7 ? 0 : putCall >= 0.5 ? -1 : -2;
  const combined = fgSignal + aaiiSignal + oscSignal + pcSignal;

  if (combined >= 5) return { label: "Strong Buy", tone: "green" };
  if (combined >= 2) return { label: "Leaning Bullish", tone: "green" };
  if (combined >= -2) return { label: "Neutral", tone: "amber" };
  if (combined >= -5) return { label: "Leaning Bearish", tone: "amber" };
  return { label: "Strong Sell Signal", tone: "red" };
}

export function SentimentGauges({ marketData, aaiiBull = 30, aaiiNeutral = 17, aaiiBear = 52, contrarianAnalysis }: Props) {
  const fgData = fearGreedContrarian(marketData.fearGreed);
  const aaiiData = aaiiBullBearContrarian(marketData.aaiiBullBear);
  const overall = overallContrarianRating(marketData.fearGreed, marketData.aaiiBullBear, marketData.spOscillator, marketData.putCall);
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

        {/* S&P Oscillator */}
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
          <div className="text-sm font-semibold text-slate-500 mb-4 flex items-center gap-2">
            S&amp;P Oscillator
            <a href="https://app.marketedge.com/#!/markets" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="MarketEdge S&P Oscillator">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          </div>
          <div className="flex items-center gap-6">
            <div className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl text-3xl font-bold ${
              marketData.spOscillator <= -4 ? "bg-emerald-100 text-emerald-700"
              : marketData.spOscillator <= -2 ? "bg-emerald-50 text-emerald-600"
              : marketData.spOscillator >= 4 ? "bg-red-100 text-red-700"
              : marketData.spOscillator >= 2 ? "bg-red-50 text-red-600"
              : "bg-slate-100 text-slate-600"
            }`}>
              {marketData.spOscillator > 0 ? "+" : ""}{marketData.spOscillator}
            </div>
            <div>
              <div className={`text-xl font-semibold ${
                marketData.spOscillator <= -4 ? "text-emerald-700"
                : marketData.spOscillator <= -2 ? "text-emerald-600"
                : marketData.spOscillator >= 4 ? "text-red-700"
                : marketData.spOscillator >= 2 ? "text-red-600"
                : "text-slate-600"
              }`}>
                {marketData.spOscillator <= -4 ? "Deeply Oversold" : marketData.spOscillator <= -2 ? "Oversold" : marketData.spOscillator >= 4 ? "Deeply Overbought" : marketData.spOscillator >= 2 ? "Overbought" : "Neutral"}
              </div>
              <p className="mt-2 text-sm text-slate-500 leading-relaxed">
                {marketData.spOscillator <= -4
                  ? "Extreme oversold conditions have historically preceded sharp mean-reversion rallies. High-conviction contrarian buy signal."
                  : marketData.spOscillator <= -2
                  ? "Market is stretched to the downside. Incrementally bullish on a contrarian basis."
                  : marketData.spOscillator >= 4
                  ? "Extreme overbought conditions. Risk of a pullback is elevated — consider trimming or hedging."
                  : marketData.spOscillator >= 2
                  ? "Market is getting stretched. Reduce marginal risk and tighten stops."
                  : "No strong directional signal from the oscillator at current levels."}
              </p>
            </div>
          </div>
        </div>

        {/* Put/Call Ratio */}
        <div className="rounded-2xl border border-slate-100 bg-slate-50 p-5">
          <div className="text-sm font-semibold text-slate-500 mb-4 flex items-center gap-2">
            Total Put/Call Ratio
            <a href="https://www.cboe.com/us/options/market_statistics/daily/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="CBOE Total Put/Call">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
            </a>
          </div>
          <div className="flex items-center gap-6">
            <div className={`flex h-20 w-20 shrink-0 items-center justify-center rounded-2xl text-3xl font-bold ${
              marketData.putCall >= 1.2 ? "bg-emerald-100 text-emerald-700"
              : marketData.putCall >= 1.0 ? "bg-emerald-50 text-emerald-600"
              : marketData.putCall <= 0.5 ? "bg-red-100 text-red-700"
              : marketData.putCall <= 0.7 ? "bg-red-50 text-red-600"
              : "bg-slate-100 text-slate-600"
            }`}>
              {marketData.putCall.toFixed(2)}
            </div>
            <div>
              <div className={`text-xl font-semibold ${
                marketData.putCall >= 1.2 ? "text-emerald-700"
                : marketData.putCall >= 1.0 ? "text-emerald-600"
                : marketData.putCall <= 0.5 ? "text-red-700"
                : marketData.putCall <= 0.7 ? "text-red-600"
                : "text-slate-600"
              }`}>
                {marketData.putCall >= 1.2 ? "Extreme Fear" : marketData.putCall >= 1.0 ? "Elevated Fear" : marketData.putCall <= 0.5 ? "Extreme Complacency" : marketData.putCall <= 0.7 ? "Complacent" : "Neutral"}
              </div>
              <p className="mt-2 text-sm text-slate-500 leading-relaxed">
                {marketData.putCall >= 1.2
                  ? "Heavy put buying signals panic. Historically a strong contrarian buy signal — protection is expensive and the crowd is hedged."
                  : marketData.putCall >= 1.0
                  ? "Put buying is elevated, suggesting caution in the market. Incrementally bullish on a contrarian basis."
                  : marketData.putCall <= 0.5
                  ? "Extreme complacency — virtually no hedging activity. This is a strong contrarian warning sign."
                  : marketData.putCall <= 0.7
                  ? "Low put demand suggests complacency. Protection is cheap, which is when disciplined PMs should be hedging."
                  : "Put/Call ratio is in a neutral range. No strong contrarian signal."}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Claude's contrarian analysis */}
      {contrarianAnalysis && (
        <div className="mt-5 border-t border-slate-100 pt-5">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-sm font-bold uppercase tracking-wider text-slate-400">Contrarian Take</span>
            <SignalPill tone={overall.tone}>{overall.label}</SignalPill>
          </div>
          <p className="text-lg leading-8 text-slate-700">{contrarianAnalysis}</p>
        </div>
      )}
    </section>
  );
}
