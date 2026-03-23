"use client";

import React, { useState } from "react";
import type { MarketData, MorningBrief as MorningBriefType, Stock } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { StatCard } from "./StatCard";
import { LoadingOverlay } from "./LoadingSpinner";
import { SentimentGauges } from "./SentimentGauges";
import { HedgingIndicator } from "./HedgingIndicator";

type Props = {
  marketData: MarketData;
  offensiveExposure: number;
  brief: MorningBriefType | null;
  stocks: Stock[];
  onBriefGenerated: (brief: MorningBriefType) => void;
};

export function MorningBrief({
  marketData,
  offensiveExposure,
  brief,
  stocks,
  onBriefGenerated,
}: Props) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  async function generateBrief() {
    setGenerating(true);
    setError("");

    try {
      const res = await fetch("/api/morning-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketData, holdings: stocks }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate brief");
      }

      const data = await res.json();
      onBriefGenerated(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate brief");
    } finally {
      setGenerating(false);
    }
  }

  const bottomLine =
    brief?.bottomLine ||
    "Click \"Generate Brief\" to have Claude analyze current market conditions and produce your morning brief.";

  const compositeAnalysis =
    brief?.compositeAnalysis ||
    "HY spreads are widening, breadth is below 50%, VIX is elevated, and sentiment is fearful without true capitulation. For PMs, that means the main risk is portfolio construction mismatch.";

  const creditAnalysis =
    brief?.creditAnalysis ||
    "Widening spreads raise the discount-rate pressure on equities and usually hit high-multiple growth first. This is often a grinding-risk backdrop rather than a one-day crash event.";

  const volatilityAnalysis =
    brief?.volatilityAnalysis ||
    "Volatility is high enough to justify disciplined hedging, but not yet at full panic levels. That usually argues for adding protection before the market reaches obvious capitulation.";

  const breadthAnalysis =
    brief?.breadthAnalysis ||
    "Index stability can be misleading when the median stock is deteriorating underneath. That is exactly when PMs need tighter exposure control and stronger sector discipline.";

  const flowsAnalysis =
    brief?.flowsAnalysis ||
    "Positioning is cautious, but not washed out. That matters because a fearful market can still become much more fearful before the real reset is complete.";

  const hedgingAnalysis =
    brief?.hedgingAnalysis ||
    "With the hedge score elevated, breadth below 50%, and spreads widening, this is the zone where PMs should add protection before any true panic signal arrives.";

  const forwardActions = brief?.forwardActions || [
    {
      priority: "High" as const,
      title: "Increase hedge ratio on growth-heavy sleeves",
      detail:
        "With the hedge score elevated, breadth below 50%, and spreads widening, this is the zone where PMs should add protection before any true panic signal arrives.",
    },
    {
      priority: "High" as const,
      title: "Trim offensive growth where regime-adjusted score weakens",
      detail:
        "Do not rewrite the fundamental score. Keep it. But use the regime multiplier to reduce position sizes where tactical fit is poor.",
    },
    {
      priority: "Medium" as const,
      title: "Rotate incremental capital toward defensive sectors",
      detail:
        "Defensive and inflation-linked sectors currently receive the positive regime multiplier. This improves tactical alignment without replacing the underlying stock work.",
    },
  ];

  return (
    <>
      {/* Header */}
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight">
            Morning Brief
          </h1>
          <p className="mt-2 text-xl text-slate-400">
            {brief?.date || marketData.date}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={generateBrief}
            disabled={generating}
            className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm font-medium text-blue-600 disabled:opacity-50 transition-opacity"
          >
            {generating ? "Generating..." : "Generate Brief"}
          </button>
        </div>
      </header>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Bottom Line */}
      <section className="relative rounded-[32px] bg-gradient-to-r from-slate-900 to-slate-700 p-8 text-white shadow-lg">
        {generating && <LoadingOverlay message="Claude is analyzing markets..." />}
        <div className="text-sm font-semibold uppercase tracking-[0.22em] text-slate-300">
          Bottom line
        </div>
        <p className="mt-5 max-w-6xl text-2xl leading-10 text-slate-50 md:text-[32px] md:leading-[1.45]">
          {bottomLine}
        </p>
      </section>

      {/* Stat Cards */}
      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          title="Composite Signal"
          value={marketData.compositeSignal}
          sub={`Conviction: ${marketData.conviction}`}
        />
        <StatCard
          title="Hedge Timing Score"
          value={`${marketData.hedgeScore}/100`}
          sub={marketData.hedgeTiming}
        />
        <StatCard
          title="Breadth (% above 200 DMA)"
          value={`${marketData.breadth}%`}
          sub="Late-cycle / deteriorating breadth"
        />
        <StatCard
          title="Portfolio regime mismatch"
          value={`${offensiveExposure.toFixed(1)}%`}
          sub="Offensive exposure in current portfolio"
        />
      </section>

      {/* Composite Signal */}
      <section className="relative rounded-[30px] border border-red-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">Composite Signal</h2>
          <SignalPill tone="red">{marketData.compositeSignal}</SignalPill>
          <span className="text-slate-500">
            Conviction: {marketData.conviction}
          </span>
        </div>
        <p className="mt-4 text-lg leading-8 text-slate-700">
          {compositeAnalysis}
        </p>
      </section>

      {/* Credit & Volatility */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-2xl font-semibold">Credit Spreads</h3>
            <SignalPill tone="red">Risk-Off</SignalPill>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">HY OAS</div>
              <div className="mt-2 text-4xl font-semibold">
                {marketData.hyOas} bps
              </div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">IG OAS</div>
              <div className="mt-2 text-4xl font-semibold">
                ~{marketData.igOas} bps
              </div>
            </div>
          </div>
          <p className="mt-5 text-lg leading-8 text-slate-600">
            {creditAnalysis}
          </p>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-2xl font-semibold">Volatility Regime</h3>
            <SignalPill tone="amber">Elevated</SignalPill>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">VIX</div>
              <div className="mt-2 text-3xl font-semibold">
                {marketData.vix}
              </div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">Term</div>
              <div className="mt-2 text-3xl font-semibold">
                {marketData.termStructure}
              </div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-sm text-slate-400">MOVE</div>
              <div className="mt-2 text-3xl font-semibold">
                {marketData.move}
              </div>
            </div>
          </div>
          <p className="mt-5 text-lg leading-8 text-slate-600">
            {volatilityAnalysis}
          </p>
        </div>
      </section>

      {/* Contrarian Sentiment Gauges */}
      <SentimentGauges marketData={marketData} />

      {/* Breadth & Flows */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-2xl font-semibold">Breadth & Internals</h3>
            <SignalPill tone="red">Deteriorating</SignalPill>
          </div>
          <div className="mt-5 space-y-4 text-lg leading-8 text-slate-700">
            <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-100 pb-3">
              <span className="text-slate-400">% Above 200 DMA</span>
              <span className="font-medium">{marketData.breadth}%</span>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-slate-100 pb-3">
              <span className="text-slate-400">Fear & Greed</span>
              <span className="font-medium">{marketData.fearGreed}/100</span>
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-4 pb-3">
              <span className="text-slate-400">Put/Call Ratio</span>
              <span className="font-medium">{marketData.putCall}</span>
            </div>
            <p>{breadthAnalysis}</p>
          </div>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-2xl font-semibold">Fund Flows & Positioning</h3>
            <SignalPill tone="red">Risk-Off</SignalPill>
          </div>
          <div className="mt-5 space-y-4 text-lg leading-8 text-slate-700">
            <p>
              <span className="text-slate-400">Fear & Greed:</span>{" "}
              <span className="font-medium">{marketData.fearGreed}/100</span>
            </p>
            <p>
              <span className="text-slate-400">AAII bull-bear spread:</span>{" "}
              <span className="font-medium">{marketData.aaiiBullBear}</span>
            </p>
            <p>
              <span className="text-slate-400">Put/Call:</span>{" "}
              <span className="font-medium">{marketData.putCall}</span>
            </p>
            <p>{flowsAnalysis}</p>
          </div>
        </div>
      </section>

      {/* Hedging Indicator */}
      <HedgingIndicator marketData={marketData} hedgingAnalysis={hedgingAnalysis} />

      {/* Forward Actions */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <h3 className="text-2xl font-semibold">Forward Actions</h3>
        <div className="mt-5 space-y-4">
          {forwardActions.map((action, i) => {
            const tone =
              action.priority === "High"
                ? "red"
                : action.priority === "Medium"
                ? "amber"
                : ("green" as const);
            const bgClass =
              action.priority === "High"
                ? "border-red-200 bg-red-50/40"
                : action.priority === "Medium"
                ? "border-amber-200 bg-amber-50/40"
                : "border-emerald-200 bg-emerald-50/40";
            return (
              <div key={i} className={`rounded-3xl border p-5 ${bgClass}`}>
                <div className="mb-2 flex items-center gap-3">
                  <SignalPill tone={tone}>{action.priority}</SignalPill>
                  <h4 className="text-xl font-semibold">{action.title}</h4>
                </div>
                <p className="text-lg leading-8 text-slate-700">
                  {action.detail}
                </p>
              </div>
            );
          })}
        </div>
      </section>
    </>
  );
}
