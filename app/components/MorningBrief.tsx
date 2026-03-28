"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import type { MarketData, MorningBrief as MorningBriefType, Stock, ScoredStock } from "@/app/lib/types";
import { SignalPill } from "./SignalPill";
import { LoadingOverlay } from "./LoadingSpinner";
import { SentimentGauges } from "./SentimentGauges";
import { HedgingIndicator } from "./HedgingIndicator";
import { ImageUpload, type BriefAttachment } from "./ImageUpload";

/** Numeric input that keeps the raw text while typing (supports "-", ".", "30.5" etc)
 *  and only commits the parsed number on blur or Enter. */
function NumericInput({
  value,
  onChange,
  className = "",
  placeholder,
}: {
  value: number;
  onChange: (n: number) => void;
  className?: string;
  placeholder?: string;
}) {
  const [text, setText] = React.useState(String(value));
  const [focused, setFocused] = React.useState(false);

  // Sync from parent when not focused
  React.useEffect(() => {
    if (!focused) setText(String(value));
  }, [value, focused]);

  function commit(raw: string) {
    const n = parseFloat(raw);
    if (!isNaN(n)) onChange(n);
    else setText(String(value));
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      value={focused ? text : String(value)}
      placeholder={placeholder}
      onFocus={() => { setFocused(true); setText(String(value)); }}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => { commit(e.target.value); setFocused(false); }}
      onKeyDown={(e) => { if (e.key === "Enter") { commit(text); (e.target as HTMLInputElement).blur(); } }}
      className={className}
    />
  );
}

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

  // Local editable state for sentiment inputs — initialise from persisted marketData
  const [fg, setFg] = useState(marketData.fearGreed);
  const [aaiiBull, setAaiiBull] = useState(marketData.aaiiBull ?? 30);
  const [aaiiNeutral, setAaiiNeutral] = useState(marketData.aaiiNeutral ?? 17);
  const [aaiiBear, setAaiiBear] = useState(marketData.aaiiBear ?? 52);

  // Track previous marketData values to detect when Redis data loads
  const prevMarketRef = useRef({ fg: marketData.fearGreed, bull: marketData.aaiiBull, ntrl: marketData.aaiiNeutral, bear: marketData.aaiiBear });
  const userEdited = useRef(false);
  useEffect(() => {
    const prev = prevMarketRef.current;
    // Only sync if marketData actually changed (i.e. Redis loaded new values) and user hasn't started editing
    if (!userEdited.current && (
      prev.fg !== marketData.fearGreed || prev.bull !== marketData.aaiiBull ||
      prev.ntrl !== marketData.aaiiNeutral || prev.bear !== marketData.aaiiBear
    )) {
      setFg(marketData.fearGreed);
      setAaiiBull(marketData.aaiiBull ?? 30);
      setAaiiNeutral(marketData.aaiiNeutral ?? 17);
      setAaiiBear(marketData.aaiiBear ?? 52);
    }
    prevMarketRef.current = { fg: marketData.fearGreed, bull: marketData.aaiiBull, ntrl: marketData.aaiiNeutral, bear: marketData.aaiiBear };
  }, [marketData.fearGreed, marketData.aaiiBull, marketData.aaiiNeutral, marketData.aaiiBear]);

  // Wrap setters to mark user edits and persist to marketData
  const setFgAndPersist = useCallback((n: number) => {
    userEdited.current = true;
    setFg(n);
    onUpdateMarketData({ fearGreed: n });
  }, [onUpdateMarketData]);
  const setAaiiAndPersist = useCallback((bull: number, ntrl: number, bear: number) => {
    userEdited.current = true;
    setAaiiBull(bull);
    setAaiiNeutral(ntrl);
    setAaiiBear(bear);
    const spread = parseFloat((bull - bear).toFixed(1));
    onUpdateMarketData({ aaiiBull: bull, aaiiNeutral: ntrl, aaiiBear: bear, aaiiBullBear: spread });
  }, [onUpdateMarketData]);

  // Attachments (screenshots for brief sections)
  const [attachments, setAttachments] = useState<BriefAttachment[]>([]);
  const attachSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load attachments on mount
  useEffect(() => {
    fetch("/api/kv/attachments")
      .then((r) => r.json())
      .then((data) => { if (data.attachments) setAttachments(data.attachments); })
      .catch(() => {});
  }, []);

  const persistAttachments = useCallback((next: BriefAttachment[]) => {
    setAttachments(next);
    if (attachSaveTimer.current) clearTimeout(attachSaveTimer.current);
    attachSaveTimer.current = setTimeout(() => {
      fetch("/api/kv/attachments", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ attachments: next }),
      }).catch((e) => console.error("Failed to save attachments:", e));
    }, 500);
  }, []);

  const addAttachment = useCallback((att: BriefAttachment) => {
    persistAttachments([...attachments, att]);
  }, [attachments, persistAttachments]);

  const removeAttachment = useCallback((id: string) => {
    persistAttachments(attachments.filter((a) => a.id !== id));
  }, [attachments, persistAttachments]);

  // Auto-fetch live market data (VIX, MOVE, HY OAS, IG OAS) on mount
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
        if (data.move != null) {
          updates.move = data.move;
          live.move = true;
        }
        // HY OAS and IG OAS are manual — not auto-fetched
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
    setGenerating(true);
    setError("");

    try {
      const res = await fetch("/api/morning-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          marketData,
          holdings: stocks,
          attachments: attachments.map((a) => ({
            section: a.section,
            label: a.label,
            dataUrl: a.dataUrl,
          })),
        }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to generate brief");
      }

      const data = await res.json();
      onBriefGenerated(data);
      // Update market regime based on Claude's assessment
      const marketUpdates: Partial<MarketData> = {};
      if (data.marketRegime) {
        marketUpdates.riskRegime = data.marketRegime;
      }
      // Auto-set equity flows from JPM screenshot analysis
      if (data.autoEquityFlows) {
        marketUpdates.equityFlows = data.autoEquityFlows;
      }
      if (Object.keys(marketUpdates).length > 0) {
        onUpdateMarketData(marketUpdates);
      }
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

  const contrarianAnalysis = brief?.contrarianAnalysis || "";

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
        <div className="grid gap-4 md:grid-cols-4 mb-6">
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">VIX</label>
              {liveFields.vix && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 uppercase">Live</span>}
            </div>
            <NumericInput
              value={marketData.vix}
              onChange={(n) => onUpdateMarketData({ vix: n })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">MOVE Index</label>
              {liveFields.move && <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-700 uppercase">Live</span>}
            </div>
            <NumericInput
              value={marketData.move}
              onChange={(n) => onUpdateMarketData({ move: n })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">HY OAS (bps)</label>
              <a href="https://fred.stlouisfed.org/series/BAMLH0A0HYM2" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="FRED HY OAS">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
            </div>
            <NumericInput
              value={marketData.hyOas}
              onChange={(n) => onUpdateMarketData({ hyOas: n })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <label className="text-sm font-medium text-slate-500">IG OAS (bps)</label>
              <a href="https://fred.stlouisfed.org/series/BAMLC0A0CM" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="FRED IG OAS">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
            </div>
            <NumericInput
              value={marketData.igOas}
              onChange={(n) => onUpdateMarketData({ igOas: n })}
              className="mt-1 w-28 rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
            />
          </div>
        </div>

        {/* ── Breadth & Market Structure ── */}
        <div className="border-t border-slate-100 pt-5 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Breadth & Market Structure</h4>
          </div>
          <div className="grid gap-4 md:grid-cols-5">
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">S&P % &gt; 200 DMA</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="MarketInOut S&P Breadth">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.breadth}
                onChange={(n) => onUpdateMarketData({ breadth: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">Nasdaq % &gt; 200 DMA</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="MarketInOut Nasdaq Breadth">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.nasdaqBreadth}
                onChange={(n) => onUpdateMarketData({ nasdaqBreadth: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">S&P % &gt; 50 DMA</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="MarketInOut 50 DMA Breadth">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.sp50dma}
                onChange={(n) => onUpdateMarketData({ sp50dma: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">NYSE A/D Line</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=advance-decline-line" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="NYSE A/D Line">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.nyseAdLine}
                onChange={(n) => onUpdateMarketData({ nyseAdLine: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">New Highs - Lows</label>
                <a href="https://www.marketinout.com/chart/market.php?breadth=new-highs-new-lows" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="New Highs vs New Lows">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.newHighsLows}
                onChange={(n) => onUpdateMarketData({ newHighsLows: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
          </div>
        </div>

        {/* ── Contrarian Indicators ── */}
        <div className="border-t border-slate-100 pt-5 mb-6">
          <div className="flex items-center gap-3 mb-4">
            <h4 className="text-sm font-semibold text-slate-500 uppercase tracking-wider">Contrarian Indicators</h4>
            <SignalPill tone="green">INVERTED SIGNALS</SignalPill>
          </div>
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">S&P Oscillator</label>
                <a href="https://app.marketedge.com/#!/markets" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="MarketEdge S&P Oscillator">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.spOscillator}
                onChange={(n) => onUpdateMarketData({ spOscillator: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">{marketData.spOscillator < 0 ? "Oversold (bullish)" : marketData.spOscillator > 0 ? "Overbought (bearish)" : "Neutral"}</p>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">Put/Call Ratio</label>
                <a href="https://www.cboe.com/us/options/market_statistics/daily/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="CBOE Total Put/Call">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={marketData.putCall}
                onChange={(n) => onUpdateMarketData({ putCall: n })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
              <p className="text-[10px] text-slate-400 mt-0.5">Total P/C ratio</p>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">CNN Fear & Greed (0-100)</label>
                <a href="https://www.cnn.com/markets/fear-and-greed" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="CNN Fear & Greed Index">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <NumericInput
                value={fg}
                onChange={setFgAndPersist}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">AAII Survey (%)</label>
                <a href="https://www.aaii.com/sentimentsurvey" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="AAII Sentiment Survey">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <div className="mt-1 flex gap-3">
                <div>
                  <span className="text-[10px] text-red-500 font-medium">Bull</span>
                  <NumericInput
                    value={aaiiBull}
                    onChange={(n) => setAaiiAndPersist(n, aaiiNeutral, aaiiBear)}
                    className="block w-16 rounded-xl border border-slate-200 px-2 py-2 text-base font-semibold"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-amber-500 font-medium">Ntrl</span>
                  <NumericInput
                    value={aaiiNeutral}
                    onChange={(n) => setAaiiAndPersist(aaiiBull, n, aaiiBear)}
                    className="block w-16 rounded-xl border border-slate-200 px-2 py-2 text-base font-semibold"
                  />
                </div>
                <div>
                  <span className="text-[10px] text-emerald-500 font-medium">Bear</span>
                  <NumericInput
                    value={aaiiBear}
                    onChange={(n) => setAaiiAndPersist(aaiiBull, aaiiNeutral, n)}
                    className="block w-16 rounded-xl border border-slate-200 px-2 py-2 text-base font-semibold"
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ── Other Manual Inputs ── */}
        <div className="border-t border-slate-100 pt-5 mb-4">
          <div className="grid gap-4 md:grid-cols-4">
            <div>
              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-slate-500">VIX Term Structure</label>
                <a href="http://vixcentral.com" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:text-blue-700" title="VIX Central">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
                </a>
              </div>
              <select
                value={marketData.termStructure}
                onChange={(e) => onUpdateMarketData({ termStructure: e.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-lg font-semibold"
              >
                <option value="Contango">Contango</option>
                <option value="Flat">Flat</option>
                <option value="Backwardation">Backwardation</option>
              </select>
            </div>
            <div>
              <label className="text-sm font-medium text-slate-500">Equity Flows</label>
              <select
                value={marketData.equityFlows}
                onChange={(e) => onUpdateMarketData({ equityFlows: e.target.value })}
                className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold"
              >
                <option value="Strong Inflows">Strong Inflows</option>
                <option value="Moderate Inflows">Moderate Inflows</option>
                <option value="Mixed">Mixed</option>
                <option value="Moderate Outflows">Moderate Outflows</option>
                <option value="Heavy Outflows">Heavy Outflows</option>
              </select>
            </div>
            <div>
              {/* Screenshot upload for flows/liquidity reports */}
              <label className="text-sm font-medium text-slate-500">JPM Flows Report</label>
              <ImageUpload
                section="equityFlows"
                sectionLabel="JPM Flows & Liquidity"
                attachments={attachments}
                onAdd={addAttachment}
                onRemove={removeAttachment}
              />
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
            VIX: <strong>{marketData.vix}</strong> | MOVE: <strong>{marketData.move}</strong> | HY: <strong>{marketData.hyOas}</strong> | Osc: <strong>{marketData.spOscillator}</strong> | F&G: <strong>{fg}</strong>
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
          {brief?.marketRegime && (
            <SignalPill tone={brief.marketRegime === "Risk-Off" ? "red" : brief.marketRegime === "Risk-On" ? "green" : "amber"}>
              {brief.marketRegime}
            </SignalPill>
          )}
        </div>
        <p className="mt-4 text-lg leading-8 text-slate-700">
          {compositeAnalysis}
        </p>
      </section>

      {/* Contrarian Sentiment — all 4 indicators + Claude analysis */}
      <SentimentGauges marketData={marketData} aaiiBull={aaiiBull} aaiiNeutral={aaiiNeutral} aaiiBear={aaiiBear} contrarianAnalysis={contrarianAnalysis} />

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
              <h3 className="text-2xl font-semibold">Breadth & Market Structure</h3>
            </div>
            <SignalPill tone={marketData.breadth <= 50 ? "red" : marketData.breadth >= 65 ? "green" : "amber"}>
              {marketData.breadth <= 50 ? "Weak" : marketData.breadth >= 65 ? "Healthy" : "Mixed"}
            </SignalPill>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                S&amp;P 500 % &gt; 200 DMA
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.breadth}%</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                Nasdaq % &gt; 200 DMA
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.nasdaqBreadth}%</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=above-sma-200" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                S&amp;P 500 % &gt; 50 DMA
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.sp50dma}%</span>
            </div>
            <div className="flex justify-between border-b border-slate-100 pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=advance-decline-line" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                NYSE A/D Line
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className="font-mono font-medium">{marketData.nyseAdLine.toLocaleString()}</span>
            </div>
            <div className="flex justify-between pb-3">
              <a href="https://www.marketinout.com/chart/market.php?breadth=new-highs-new-lows" target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-blue-600 flex items-center gap-1.5">
                New Highs - Lows
                <svg className="w-3 h-3 text-blue-400" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" /></svg>
              </a>
              <span className={`font-mono font-medium ${marketData.newHighsLows > 0 ? "text-emerald-600" : marketData.newHighsLows < -50 ? "text-red-600" : "text-slate-700"}`}>
                {marketData.newHighsLows > 0 ? "+" : ""}{marketData.newHighsLows}
              </span>
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
            <SignalPill tone={
              marketData.equityFlows.includes("Outflow") ? "red"
              : marketData.equityFlows.includes("Inflow") ? "green"
              : "amber"
            }>
              {marketData.equityFlows}
            </SignalPill>
          </div>
          <div className="mt-5 space-y-3">
            <div className="flex justify-between pb-3">
              <span className="text-slate-500">Equity Flows</span>
              <span className="font-medium">{marketData.equityFlows}</span>
            </div>
          </div>
          <p className="mt-4 text-lg leading-8 text-slate-600">{flowsAnalysis}</p>

          {/* Attached screenshots displayed inline */}
          {attachments.filter((a) => a.section === "equityFlows").length > 0 && (
            <div className="mt-5 border-t border-slate-100 pt-5">
              <div className="text-xs font-bold uppercase tracking-wider text-slate-400 mb-3">
                JPM Flows & Liquidity Report
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                {attachments
                  .filter((a) => a.section === "equityFlows")
                  .map((att) => (
                    <div key={att.id} className="rounded-xl border border-slate-200 overflow-hidden">
                      <img
                        src={att.dataUrl}
                        alt={att.label}
                        className="w-full h-auto"
                      />
                      <div className="px-3 py-1.5 bg-slate-50 text-xs text-slate-500">
                        {att.label}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Hedging Window */}
      <HedgingIndicator marketData={marketData} hedgingAnalysis={hedgingAnalysis} />

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
