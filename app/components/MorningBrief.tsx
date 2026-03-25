"use client";

import React, { useState, useEffect } from "react";
import type { MarketData, MorningBrief as MorningBriefType, Stock, ScoredStock } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { LoadingOverlay } from "./LoadingSpinner";
import { SentimentGauges } from "./SentimentGauges";
import { HedgingIndicator } from "./HedgingIndicator";

type Props = {
  marketData: MarketData;
  offensiveExposure: number;
  brief: MorningBriefType | null;
  stocks: Stock[];
  scoredStocks: ScoredStock[];
  onBriefGenerated: (brief: MorningBriefType) => void;
  onUpdateMarketData: (updates: Partial<MarketData>) => void;
};

export function MorningBrief({
  marketData,
  offensiveExposure,
  brief,
  stocks,
  scoredStocks,
  onBriefGenerated,
  onUpdateMarketData,
}: Props) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [liveLoading, setLiveLoading] = useState(false);
  const [liveFields, setLiveFields] = useState<Record<string, boolean>>({});

  // Local editable state for sentiment inputs
  const [fg, setFg] = useState(marketData.fearGreed);
  const [aaiiBull, setAaiiBull] = useState(30);
  const [aaiiNeutral, setAaiiNeutral] = useState(17);
  const [aaiiBear, setAaiiBear] = useState(52);

  // Auto-fetch live market data (VIX, HY OAS, IG OAS) on mount
  useEffect(() => {
    let cancelled = false;
    async function fetchLiveData() {
      setLiveLoading(true);
      try {
        const res = await fetch("/api/market-data");
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const updates: Partial<MarketData> = {};
        const live: Record<string, boolean> = {};
        if (data.vix != null) {
          updates.vix = data.vix;
          live.vix = true;
        }
        if (data.hyOas != null) {
          updates.hyOas = data.hyOas;
          live.hyOas = true;
        }
        if (data.igOas != null) {
          updates.igOas = data.igOas;
          live.igOas = true;
        }
        if (Object.keys(updates).length > 0) {
          onUpdateMarketData(updates);
        }
        setLiveFields(live);
      } catch {
        // Silently fail — user can still enter manually
      } finally {
        if (!cancelled) setLiveLoading(false);
      }
    }
    fetchLiveData();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function generateBrief() {
    // Sync editable inputs to market data
    const bullBearSpread = parseFloat((aaiiBull - aaiiBear).toFixed(1));
    onUpdateMarketData({ fearGreed: fg, aaiiBullBear: bullBearSpread });

    setGenerating(true);
    setError("");

    try {
      const updatedMarketData = {
        ...marketData,
        fearGreed: fg,
        aaiiBullBear: bullBearSpread,
      };
      const res = await fetch("/api/morning-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ marketData: updatedMarketData, holdings: stocks }),
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
    "Click \"Refresh Brief\" to have Claude analyze current market conditions and produce your morning brief.";

  const compositeAnalysis =
    brief?.compositeAnalysis ||
    "Composite analysis will appear here after generating the brief.";

  const creditAnalysis =
    brief?.creditAnalysis ||
    "Credit spread analysis will appear here after generating the brief.";

  const volatilityAnalysis =
    brief?.volatilityAnalysis ||
    "Volatility regime analysis will appear here after generating the brief.";

  const breadthAnalysis =
    brief?.breadthAnalysis ||
    "Breadth & internals analysis will appear here after generating the brief.";

  const flowsAnalysis =
    brief?.flowsAnalysis ||
    "Fund flows & positioning analysis will appear here after generating the brief.";

  const hedgingAnalysis = brief?.hedgingAnalysis || "";

  const sectorRotation = brief?.sectorRotation || null;

  const riskScan = brief?.riskScan || null;

  const forwardActions = brief?.forwardActions || [];

  const compositeSignalTone = marketData.compositeSignal.toLowerCase().includes("bear")
    ? "red" as const
    : marketData.compositeSignal.toLowerCase().includes("bull")
    ? "green" as const
    : "amber" as const;

  return (
    <>
      {/* Editable Market & Sentiment Inputs */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-5">
          <h3 className="text-xl font-semibold">Daily Market Input</h3>
          {liveLoading && <span className="text-xs text-blue-500 animate-pulse">Fetching live data...</span>}
        </div>

        {/* Live-fetched fields */}
        <div className="grid gap-4 md:grid-cols-3 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">VIX</label>
              {liveFields.vix && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 uppercase">Live</span>}
            </div>
            <input
              type="number"
              step="0.1"
              value={marketData.vix}
              onChange={(e) => onUpdateMarketData({ vix: Number(e.target.value) })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">HY OAS (bps)</label>
              {liveFields.hyOas && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 uppercase">Live</span>}
            </div>
            <input
              type="number"
              value={marketData.hyOas}
              onChange={(e) => onUpdateMarketData({ hyOas: Number(e.target.value) })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">IG OAS (bps)</label>
              {liveFields.igOas && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 uppercase">Live</span>}
            </div>
            <input
              type="number"
              value={marketData.igOas}
              onChange={(e) => onUpdateMarketData({ igOas: Number(e.target.value) })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
        </div>

        {/* Manual fields */}
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <div>
            <label className="text-sm font-medium text-slate-500">MOVE Index</label>
            <input
              type="number"
              step="0.1"
              value={marketData.move}
              onChange={(e) => onUpdateMarketData({ move: Number(e.target.value) })}
              className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-500">Breadth (% &gt; 200 DMA)</label>
            <input
              type="number"
              step="0.1"
              value={marketData.breadth}
              onChange={(e) => onUpdateMarketData({ breadth: Number(e.target.value) })}
              className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-500">Put/Call Ratio</label>
            <input
              type="number"
              step="0.01"
              value={marketData.putCall}
              onChange={(e) => onUpdateMarketData({ putCall: Number(e.target.value) })}
              className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-500">VIX Term Structure</label>
            <select
              value={marketData.termStructure}
              onChange={(e) => onUpdateMarketData({ termStructure: e.target.value })}
              className="mt-1 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            >
              <option value="Contango">Contango</option>
              <option value="Flat">Flat</option>
              <option value="Backwardation">Backwardation</option>
            </select>
          </div>
        </div>

        {/* Sentiment inputs */}
        <div className="border-t border-slate-100 pt-5">
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Sentiment (Manual)</h4>
            <SignalPill tone="green">CONTRARIAN</SignalPill>
          </div>
          <div className="grid gap-6 md:grid-cols-2">
            <div>
              <label className="text-sm font-medium text-slate-500">CNN Fear & Greed (0-100)</label>
              <input
                type="number"
                min={0}
                max={100}
                value={fg}
                onChange={(e) => setFg(Number(e.target.value))}
                className="mt-1 w-24 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-slate-500">AAII Survey (%)</label>
              <div className="mt-1 flex gap-4">
                <div>
                  <span className="text-xs text-red-500 font-medium">Bull</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={aaiiBull}
                    onChange={(e) => setAaiiBull(Number(e.target.value))}
                    className="block w-20 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
                  />
                </div>
                <div>
                  <span className="text-xs text-amber-500 font-medium">Neutral</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={aaiiNeutral}
                    onChange={(e) => setAaiiNeutral(Number(e.target.value))}
                    className="block w-20 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
                  />
                </div>
                <div>
                  <span className="text-xs text-emerald-500 font-medium">Bear</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={aaiiBear}
                    onChange={(e) => setAaiiBear(Number(e.target.value))}
                    className="block w-20 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-5 flex items-center gap-4">
          <button
            onClick={generateBrief}
            disabled={generating}
            className="rounded-2xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {generating ? "Generating..." : "\u21BB Refresh Brief"}
          </button>
          <span className="text-sm text-slate-400">
            VIX: <strong>{marketData.vix}</strong> | HY: <strong>{marketData.hyOas}</strong> | F&G: <strong>{fg}</strong> | AAII: <strong>{aaiiBull}%</strong>B / <strong>{aaiiBear}%</strong>Be
          </span>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* Header */}
      <header>
        <h1 className="text-4xl font-semibold tracking-tight">Morning Brief</h1>
        <p className="mt-2 text-xl text-slate-400">{brief?.date || marketData.date}</p>
      </header>

      {/* Bottom Line */}
      <section className="relative rounded-[30px] bg-amber-50 border border-amber-200 p-8 shadow-sm">
        {generating && <LoadingOverlay message="Claude is analyzing markets..." />}
        <div className="text-sm font-bold uppercase tracking-[0.22em] text-amber-700 mb-4">
          Bottom line
        </div>
        <p className="max-w-6xl text-lg leading-8 text-slate-800">
          {bottomLine}
        </p>
      </section>

      {/* Composite Signal */}
      <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-2xl">🔍</span>
          <h2 className="text-2xl font-semibold">Composite Signal</h2>
          <SignalPill tone={compositeSignalTone}>{marketData.compositeSignal}</SignalPill>
          <span className="text-slate-500">
            Conviction: {marketData.conviction}
          </span>
        </div>
        <p className="mt-4 text-lg leading-8 text-slate-700">
          {compositeAnalysis}
        </p>
      </section>

      {/* Contrarian Sentiment Gauges */}
      <SentimentGauges marketData={{...marketData, fearGreed: fg, aaiiBullBear: parseFloat((aaiiBull - aaiiBear).toFixed(1))}} aaiiBull={aaiiBull} aaiiNeutral={aaiiNeutral} aaiiBear={aaiiBear} />

      {/* Credit & Volatility */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">📉</span>
              <h3 className="text-2xl font-semibold">Credit Spreads</h3>
            </div>
            <SignalPill tone={marketData.hyOas >= 300 ? "red" : marketData.hyOas >= 200 ? "amber" : "green"}>
              {marketData.hyOas >= 300 ? "Widening" : marketData.hyOas >= 200 ? "Neutral" : "Tight"}
            </SignalPill>
          </div>
          <div className="mt-5 grid grid-cols-2 gap-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">HY OAS</div>
              <div className="mt-2 text-3xl font-bold">{marketData.hyOas} <span className="text-base font-normal text-slate-400">bps</span></div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">IG OAS</div>
              <div className="mt-2 text-3xl font-bold">{marketData.igOas} <span className="text-base font-normal text-slate-400">bps</span></div>
            </div>
          </div>
          <p className="mt-4 text-sm text-slate-500">Trend: {marketData.hyOas >= 300 ? "Widening modestly" : "Stable"}</p>
          <p className="mt-2 text-lg leading-8 text-slate-600">{creditAnalysis}</p>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">⚡</span>
              <h3 className="text-2xl font-semibold">Volatility Regime</h3>
            </div>
            <SignalPill tone={marketData.vix >= 22 ? "red" : marketData.vix >= 16 ? "amber" : "green"}>
              {marketData.vix >= 22 ? "Elevated" : marketData.vix >= 16 ? "Moderate" : "Low"}
            </SignalPill>
          </div>
          <div className="mt-5 grid grid-cols-3 gap-4">
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">VIX</div>
              <div className="mt-2 text-3xl font-bold">{marketData.vix}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">TERM</div>
              <div className="mt-2 text-xl font-bold">{marketData.termStructure}</div>
            </div>
            <div className="rounded-2xl bg-slate-50 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">MOVE</div>
              <div className="mt-2 text-3xl font-bold">{marketData.move}</div>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{volatilityAnalysis}</p>
        </div>
      </section>

      {/* Breadth & Flows */}
      <section className="grid gap-5 lg:grid-cols-2">
        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">📊</span>
              <h3 className="text-2xl font-semibold">Breadth & Internals</h3>
            </div>
            <SignalPill tone={marketData.breadth <= 50 ? "red" : "amber"}>
              {marketData.breadth <= 50 ? "Bearish" : "Mixed"}
            </SignalPill>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <span className="text-slate-500">A/D Line</span>
              <span className="font-medium">Deteriorating</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <span className="text-slate-500">% Above 200 DMA</span>
              <span className="font-mono font-medium">{marketData.breadth}%</span>
            </div>
            <div className="flex justify-between pb-3">
              <span className="text-slate-500">New Highs/Lows</span>
              <span className="font-medium">Negative divergence</span>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{breadthAnalysis}</p>
        </div>

        <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="text-xl">💰</span>
              <h3 className="text-2xl font-semibold">Fund Flows & Positioning</h3>
            </div>
            <SignalPill tone="amber">Mixed</SignalPill>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <span className="text-slate-500">Equity Flows</span>
              <span className="font-medium">Mixed</span>
            </div>
            <div className="flex justify-between pb-3">
              <span className="text-slate-500">Put/Call Ratio</span>
              <span className="font-mono font-medium">{marketData.putCall}</span>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{flowsAnalysis}</p>
        </div>
      </section>

      {/* Hedging Window */}
      <HedgingIndicator marketData={{...marketData, fearGreed: fg}} hedgingAnalysis={hedgingAnalysis} />

      {/* Sector Rotation */}
      {sectorRotation && (
        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <span className="text-xl">🔄</span>
            <h3 className="text-2xl font-semibold">Sector Rotation</h3>
          </div>
          <p className="text-lg leading-8 text-slate-700 mb-5">{sectorRotation.summary}</p>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <div className="text-sm font-bold uppercase tracking-wider text-emerald-600 mb-2">LEADING</div>
              {sectorRotation.leading.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-emerald-700 mb-1">
                  <span>▲</span> <span>{s}</span>
                </div>
              ))}
            </div>
            <div>
              <div className="text-sm font-bold uppercase tracking-wider text-red-600 mb-2">LAGGING</div>
              {sectorRotation.lagging.map((s, i) => (
                <div key={i} className="flex items-center gap-2 text-red-600 mb-1">
                  <span>▼</span> <span>{s}</span>
                </div>
              ))}
            </div>
          </div>
          <p className="mt-4 text-lg italic leading-8 text-slate-500">{sectorRotation.pmImplication}</p>
        </section>
      )}

      {/* Portfolio Risk Scan */}
      {riskScan && riskScan.length > 0 && (
        <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">🛡️</span>
            <h3 className="text-2xl font-semibold">Portfolio Risk Scan</h3>
          </div>
          <div className="space-y-3">
            {riskScan.map((item, i) => {
              const bgClass =
                item.priority === "High"
                  ? "border-l-red-400 bg-red-50/30"
                  : item.priority === "Medium-High"
                  ? "border-l-amber-400 bg-amber-50/30"
                  : "border-l-slate-300 bg-slate-50/30";
              const tonePill =
                item.priority === "High"
                  ? "red" as const
                  : item.priority === "Medium-High"
                  ? "amber" as const
                  : "gray" as const;
              return (
                <div key={i} className={`rounded-2xl border-l-4 p-4 ${bgClass}`}>
                  <div className="flex flex-wrap items-center gap-3 mb-1">
                    <span className="font-mono text-lg font-bold">{item.ticker}</span>
                    <SignalPill tone={tonePill}>{item.priority}</SignalPill>
                    <span className="text-slate-700">{item.summary}</span>
                  </div>
                  <div className="text-blue-600 font-medium">&rarr; {item.action}</div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Action Items */}
      {forwardActions.length > 0 && (
        <section className="rounded-[30px] border border-amber-100 bg-amber-50/30 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-xl">⚡</span>
            <h3 className="text-2xl font-semibold">Action Items</h3>
          </div>
          <div className="space-y-3">
            {forwardActions.map((action, i) => {
              const bgClass =
                action.priority === "High"
                  ? "border-red-200 bg-red-50/40"
                  : action.priority === "Medium"
                  ? "border-amber-200 bg-amber-50/60"
                  : "border-emerald-200 bg-emerald-50/40";
              return (
                <div key={i} className={`rounded-2xl border p-5 ${bgClass}`}>
                  <div className="flex items-start gap-4">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-200 text-sm font-bold text-amber-800">
                      {i + 1}
                    </div>
                    <div>
                      <h4 className="text-lg font-semibold">{action.title}</h4>
                      <p className="mt-1 text-slate-600 leading-7">{action.detail}</p>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </>
  );
}
