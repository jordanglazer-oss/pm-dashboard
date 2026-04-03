"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import type { TechnicalIndicators, ImprovingScore } from "@/app/lib/technicals";
import type { Stock } from "@/app/lib/types";

type ScanResult = {
  ticker: string;
  price: number;
  priceChange5d: number;
  priceChange20d: number;
  technicals: TechnicalIndicators;
  improving: ImprovingScore;
};

function SignalRow({ label, signal, detail }: { label: string; signal: "bullish" | "bearish" | "neutral"; detail: string }) {
  const color = signal === "bullish" ? "bg-emerald-100 text-emerald-700" : signal === "bearish" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-500";
  return (
    <div className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
      <span className="text-sm text-slate-700">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-sm text-slate-600">{detail}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${color}`}>{signal}</span>
      </div>
    </div>
  );
}

const ZERO_SCORES = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

export default function ScanPreviewPage() {
  const params = useParams();
  const router = useRouter();
  const rawTicker = decodeURIComponent(params.ticker as string);
  const { addStock, scoredStocks } = useStocks();
  const [data, setData] = useState<ScanResult | null>(null);
  const [added, setAdded] = useState(false);

  // Check if already in portfolio/watchlist
  const cleanTicker = rawTicker.replace(".TO", "").toUpperCase();
  const alreadyExists = scoredStocks.some((s) => s.ticker === cleanTicker);

  useEffect(() => {
    if (alreadyExists) {
      router.replace(`/stock/${cleanTicker.toLowerCase()}`);
      return;
    }
    try {
      const raw = sessionStorage.getItem(`scan_preview_${rawTicker}`);
      if (raw) setData(JSON.parse(raw));
    } catch {}
  }, [rawTicker, alreadyExists, cleanTicker, router]);

  if (!data) {
    return (
      <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8">
        <div className="mx-auto max-w-3xl">
          <div className="rounded-[30px] border border-slate-200 bg-white p-8 text-center shadow-sm">
            <h1 className="text-2xl font-semibold text-slate-900">No preview data</h1>
            <p className="mt-2 text-slate-500">Return to the screener and click a stock from the scan results.</p>
            <Link href="/screener" className="mt-4 inline-block text-teal-600 hover:underline text-sm">Back to Screener</Link>
          </div>
        </div>
      </main>
    );
  }

  const t = data.technicals;
  const imp = data.improving;

  function getTrendSignal(): "bullish" | "bearish" | "neutral" {
    if (t.dmaSignal === "golden_cross" || t.dmaSignal === "above_both") return "bullish";
    if (t.dmaSignal === "death_cross" || t.dmaSignal === "below_both") return "bearish";
    return "neutral";
  }
  function getRsiSignal(): "bullish" | "bearish" | "neutral" {
    if (t.rsi14 < 30) return "bullish"; if (t.rsi14 > 70) return "bearish"; return "neutral";
  }
  function getMacdSignal(): "bullish" | "bearish" | "neutral" {
    if (t.macdSignal === "bullish_crossover" || t.macdSignal === "bullish") return "bullish";
    if (t.macdSignal === "bearish_crossover" || t.macdSignal === "bearish") return "bearish";
    return "neutral";
  }
  function getIchimokuSignal(): "bullish" | "bearish" | "neutral" {
    const s = t.ichimoku.overallSignal;
    if (s === "strong_bullish" || s === "bullish") return "bullish";
    if (s === "strong_bearish" || s === "bearish") return "bearish";
    return "neutral";
  }
  function getVolumeSignal(): "bullish" | "bearish" | "neutral" {
    if (t.volumeSignal === "high_volume" && t.priceChange5d > 0) return "bullish";
    if (t.volumeSignal === "high_volume" && t.priceChange5d < -2) return "bearish";
    return "neutral";
  }
  function getWeek52Signal(): "bullish" | "bearish" | "neutral" {
    if (t.week52Position >= 0.7) return "bullish"; if (t.week52Position <= 0.3) return "bearish"; return "neutral";
  }

  const signals = [getTrendSignal(), getRsiSignal(), getMacdSignal(), getIchimokuSignal(), getVolumeSignal(), getWeek52Signal()];
  const bullish = signals.filter((s) => s === "bullish").length;
  const bearish = signals.filter((s) => s === "bearish").length;
  const net = bullish - bearish;
  const compositeColor = net >= 3 ? "text-emerald-700" : net >= 1 ? "text-emerald-600" : net <= -3 ? "text-red-700" : net <= -1 ? "text-red-600" : "text-slate-600";

  const handleAdd = () => {
    const stock: Stock = {
      ticker: cleanTicker,
      name: rawTicker,
      bucket: "Watchlist",
      sector: "Technology",
      beta: 1.0,
      weights: { portfolio: 0 },
      scores: { ...ZERO_SCORES },
      notes: `Added from scan. Improving score: ${imp.score}/6.`,
      price: data.price,
      technicals: data.technicals,
    };
    addStock(stock);
    setAdded(true);
  };

  return (
    <main className="min-h-screen bg-[#f4f5f7] text-slate-900 overflow-x-hidden">
      {/* Nav bar */}
      <div className="border-b border-slate-200 bg-white px-4 py-2.5 md:px-8">
        <div className="flex items-center gap-3">
          <Link href="/screener" className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-50 transition-colors">
            &larr; Screener
          </Link>
          <span className="text-[10px] font-semibold uppercase tracking-wider text-teal-500">Scan Preview</span>
        </div>
      </div>

      <div className="px-4 py-6 md:px-8 md:py-8">
        <div className="mx-auto max-w-3xl space-y-6">
          {/* Header */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex items-baseline gap-3 mb-2">
              <h1 className="text-3xl font-bold font-mono tracking-tight">{rawTicker}</h1>
              <span className="text-2xl font-semibold text-slate-600">${data.price.toFixed(2)}</span>
              <span className="rounded-full bg-teal-100 text-teal-700 px-2.5 py-0.5 text-xs font-semibold">Scan Result</span>
            </div>

            <div className="flex items-center gap-3 mb-4">
              {added || alreadyExists ? (
                <span className="rounded-lg bg-slate-100 px-4 py-1.5 text-sm font-medium text-slate-400">Added to Watchlist</span>
              ) : (
                <button onClick={handleAdd}
                  className="rounded-lg bg-teal-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 transition-colors">
                  + Add to Watchlist
                </button>
              )}
              <span className={`text-sm font-semibold ${data.priceChange5d >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                5d: {data.priceChange5d >= 0 ? "+" : ""}{data.priceChange5d.toFixed(1)}%
              </span>
              <span className={`text-sm font-semibold ${data.priceChange20d >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                20d: {data.priceChange20d >= 0 ? "+" : ""}{data.priceChange20d.toFixed(1)}%
              </span>
            </div>

            {/* Composite score */}
            <div className="flex items-center gap-3 mb-2">
              <span className="text-sm text-slate-500">Composite Technical Score:</span>
              <span className={`text-lg font-bold ${compositeColor}`}>{net > 0 ? "+" : ""}{net}</span>
              <span className="text-xs text-slate-400">({bullish} bullish, {bearish} bearish)</span>
            </div>
          </div>

          {/* Improving Signals */}
          <div className="rounded-[30px] border border-teal-200 bg-white p-6 shadow-sm">
            <div className="flex items-center gap-3 mb-4">
              <h2 className="text-lg font-bold text-slate-800">Improving Signals</h2>
              <span className="rounded-full bg-teal-100 text-teal-700 px-2.5 py-0.5 text-sm font-bold">{imp.score}/6</span>
            </div>
            <div className="space-y-2">
              {imp.signals.map((s) => (
                <div key={s.name} className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
                  <span className="text-sm text-slate-700">{s.name}</span>
                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${s.active ? "bg-teal-100 text-teal-700" : "bg-slate-100 text-slate-400"}`}>
                    {s.active ? "Active" : "Inactive"}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Technical Signals */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Technical Signals</h2>
            <SignalRow label="Trend (DMA)" signal={getTrendSignal()} detail={t.dmaSignal.replace(/_/g, " ")} />
            <SignalRow label="RSI (14)" signal={getRsiSignal()} detail={t.rsi14.toFixed(1)} />
            <SignalRow label="MACD" signal={getMacdSignal()} detail={`Histogram: ${t.macdHistogram >= 0 ? "+" : ""}${t.macdHistogram.toFixed(2)}`} />
            <SignalRow label="Ichimoku Cloud" signal={getIchimokuSignal()} detail={t.ichimoku.overallSignal.replace(/_/g, " ")} />
            <SignalRow label="Volume" signal={getVolumeSignal()} detail={`${t.volumeRatio.toFixed(1)}x avg`} />
            <SignalRow label="52-Week Position" signal={getWeek52Signal()} detail={`${(t.week52Position * 100).toFixed(0)}%`} />
          </div>

          {/* Key Levels */}
          <div className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
            <h2 className="text-lg font-bold text-slate-800 mb-4">Key Levels</h2>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">SMA 50</div>
                <div className="mt-1 text-lg font-semibold font-mono">${t.sma50.toFixed(2)}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">SMA 200</div>
                <div className="mt-1 text-lg font-semibold font-mono">${t.sma200.toFixed(2)}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">52W High</div>
                <div className="mt-1 text-lg font-semibold font-mono">${t.week52High.toFixed(2)}</div>
              </div>
              <div className="rounded-2xl bg-slate-50 p-3">
                <div className="text-xs text-slate-400">52W Low</div>
                <div className="mt-1 text-lg font-semibold font-mono">${t.week52Low.toFixed(2)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
