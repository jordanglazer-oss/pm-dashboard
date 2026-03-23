"use client";

import React from "react";
import type { MarketData } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";

type Props = {
  marketData: MarketData;
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
        "Fear is elevated but not extreme. The crowd is cautious, which reduces the probability of a further severe drawdown from current levels. Watch for a washout below 15 before getting aggressive.",
    };
  if (value <= 55)
    return {
      signal: "Neutral",
      tone: "amber",
      detail:
        "Sentiment is balanced. No strong contrarian signal in either direction. Focus on fundamentals and regime fit rather than sentiment timing.",
    };
  if (value <= 75)
    return {
      signal: "Leaning Bearish",
      tone: "amber",
      detail:
        "Complacency is building. Elevated greed readings suggest the market is pricing in good outcomes without adequate risk premium. Consider tightening stops and reducing marginal risk.",
    };
  return {
    signal: "Contrarian Bearish",
    tone: "red",
    detail:
      "Extreme greed is a reliable warning sign. The crowd is euphoric and positioned long. This is where PMs should be raising cash, adding hedges, and trimming positions into strength.",
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
        "Retail investors are deeply bearish. Historically, AAII spreads below -20 have preceded above-average 6-12 month returns. The crowd is wrong at extremes.",
    };
  if (spread <= -5)
    return {
      signal: "Leaning Bullish",
      tone: "green",
      detail:
        "Bears outnumber bulls by a meaningful margin. Sentiment is pessimistic but not yet at washout extremes. Incrementally supportive for forward returns.",
    };
  if (spread <= 15)
    return {
      signal: "Neutral",
      tone: "amber",
      detail:
        "Sentiment is roughly balanced. No actionable contrarian signal from the AAII survey at current levels.",
    };
  if (spread <= 30)
    return {
      signal: "Leaning Bearish",
      tone: "amber",
      detail:
        "Bulls are gaining confidence. Elevated bullish sentiment tends to precede periods of below-average returns. Not extreme, but worth monitoring.",
    };
  return {
    signal: "Contrarian Bearish",
    tone: "red",
    detail:
      "Retail euphoria is extreme. AAII spreads above +30 are rare and have historically marked intermediate tops. PMs should be defensive.",
  };
}

function GaugeBar({ value, min, max, label }: { value: number; min: number; max: number; label: string }) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-slate-500 mb-1.5">
        <span>{label}</span>
        <span className="font-semibold text-slate-900">{value}</span>
      </div>
      <div className="relative h-3 rounded-full bg-gradient-to-r from-emerald-400 via-amber-300 to-red-400 overflow-hidden">
        <div
          className="absolute top-0 h-full w-1 bg-slate-900 rounded-full shadow-md ring-2 ring-white"
          style={{ left: `calc(${pct}% - 2px)` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-400 mt-1">
        <span>Extreme Fear</span>
        <span>Neutral</span>
        <span>Extreme Greed</span>
      </div>
    </div>
  );
}

function SpreadBar({ value }: { value: number }) {
  // AAII spread typically ranges from -40 to +40
  const pct = Math.max(0, Math.min(100, ((value + 40) / 80) * 100));

  return (
    <div>
      <div className="flex items-center justify-between text-sm text-slate-500 mb-1.5">
        <span>Bull-Bear Spread</span>
        <span className="font-semibold text-slate-900">{value > 0 ? "+" : ""}{value}</span>
      </div>
      <div className="relative h-3 rounded-full bg-gradient-to-r from-emerald-400 via-slate-200 to-red-400 overflow-hidden">
        <div
          className="absolute top-0 h-full w-1 bg-slate-900 rounded-full shadow-md ring-2 ring-white"
          style={{ left: `calc(${pct}% - 2px)` }}
        />
      </div>
      <div className="flex justify-between text-xs text-slate-400 mt-1">
        <span>Deep Bearish</span>
        <span>Neutral</span>
        <span>Deep Bullish</span>
      </div>
    </div>
  );
}

export function SentimentGauges({ marketData }: Props) {
  const fgData = fearGreedContrarian(marketData.fearGreed);
  const aaiiData = aaiiBullBearContrarian(marketData.aaiiBullBear);

  return (
    <section className="grid gap-5 lg:grid-cols-2">
      {/* CNN Fear & Greed */}
      <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-2xl font-semibold">CNN Fear & Greed</h3>
          <div className="flex items-center gap-2">
            <SignalPill tone="gray">{fearGreedLabel(marketData.fearGreed)}</SignalPill>
            <SignalPill tone={fgData.tone}>{fgData.signal}</SignalPill>
          </div>
        </div>

        <div className="mt-5 flex items-end gap-6">
          <div>
            <div className="text-sm text-slate-400">Current Reading</div>
            <div className="mt-1 text-5xl font-bold tracking-tight text-slate-900">
              {marketData.fearGreed}
              <span className="text-lg font-normal text-slate-400">/100</span>
            </div>
          </div>
          <div className="text-sm text-slate-400 pb-1">Contrarian indicator</div>
        </div>

        <div className="mt-5">
          <GaugeBar value={marketData.fearGreed} min={0} max={100} label="Sentiment Gauge" />
        </div>

        <p className="mt-5 text-lg leading-8 text-slate-600">{fgData.detail}</p>
      </div>

      {/* AAII Investor Sentiment */}
      <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-2xl font-semibold">AAII Sentiment Survey</h3>
          <SignalPill tone={aaiiData.tone}>{aaiiData.signal}</SignalPill>
        </div>

        <div className="mt-5 flex items-end gap-6">
          <div>
            <div className="text-sm text-slate-400">Bull-Bear Spread</div>
            <div className="mt-1 text-5xl font-bold tracking-tight text-slate-900">
              {marketData.aaiiBullBear > 0 ? "+" : ""}
              {marketData.aaiiBullBear}
            </div>
          </div>
          <div className="text-sm text-slate-400 pb-1">Contrarian indicator</div>
        </div>

        <div className="mt-5">
          <SpreadBar value={marketData.aaiiBullBear} />
        </div>

        <p className="mt-5 text-lg leading-8 text-slate-600">{aaiiData.detail}</p>

        <div className="mt-4 rounded-2xl bg-slate-50 p-4">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">
            Historical Context
          </div>
          <div className="text-sm text-slate-600 leading-relaxed">
            AAII spreads below -20 have historically preceded average 12-month S&P 500 returns of +15-20%.
            Above +30 has preceded average returns of just +2-5%. The crowd is reliably wrong at extremes.
          </div>
        </div>
      </div>
    </section>
  );
}
