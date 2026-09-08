"use client";

import React, { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { useStocks } from "@/app/lib/StockContext";
import type { TechnicalIndicators, ImprovingScore } from "@/app/lib/technicals";
import type { Stock } from "@/app/lib/types";
import StockChart from "@/app/components/StockChart";
import { AppIcon } from "@/app/components/AppIcon";
import { EmptyState } from "@/app/components/EmptyState";

type ScanResult = {
  ticker: string;
  name: string;
  sector: string;
  price: number;
  priceChange5d: number;
  priceChange20d: number;
  technicals: TechnicalIndicators;
  improving: ImprovingScore;
};

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] !text-ink-2 hover:bg-surface-hover hover:!text-ink";
const BTN_PRI = "inline-flex h-7 items-center gap-1.5 rounded-control bg-ink px-2.5 text-[12.5px] font-medium text-white hover:bg-ink-2";

const SIGNAL_DOT = { bullish: "bg-pos", bearish: "bg-neg", neutral: "bg-ink-faint" } as const;
const SIGNAL_CLS = { bullish: "text-pos", bearish: "text-neg", neutral: "text-ink-3" } as const;

/** One signal row: label · reading · dot + word. */
function SignalRow({ label, signal, detail }: { label: string; signal: "bullish" | "bearish" | "neutral"; detail: string }) {
  return (
    <tr>
      <td className="pl-3.5 text-ink-2">{label}</td>
      <td className="n text-ink-2">{detail}</td>
      <td className={`pr-3.5 text-right ${SIGNAL_CLS[signal]}`}>
        <span className="inline-flex items-center gap-1.5"><span className={`dot ${SIGNAL_DOT[signal]}`} />{signal}</span>
      </td>
    </tr>
  );
}

const ZERO_SCORES = {
  brand: 0, secular: 0, researchCoverage: 0, marketEdge: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

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
      // Mount-time hydration from sessionStorage — intentional setState in effect.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (raw) setData(JSON.parse(raw));
    } catch {}
  }, [rawTicker, alreadyExists, cleanTicker, router]);

  if (!data) {
    return (
      <div className="flex flex-col gap-3.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <Link href="/screener" className={BTN}><AppIcon name="arrowL" size={13} strokeWidth={2} /> Screener</Link>
          <span className="text-[11.5px] text-ink-3">Scan preview · {rawTicker}</span>
        </div>
        <section className="panel">
          <EmptyState
            glyph={<AppIcon name="search" size={18} />}
            title="No preview data"
            body="Return to the screener and click a stock from the scan results."
            action={<Link href="/screener" className={BTN}><AppIcon name="arrowL" size={13} strokeWidth={2} /> Back to screener</Link>}
          />
        </section>
      </div>
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
  const compositeColor = net >= 1 ? "text-pos" : net <= -1 ? "text-neg" : "text-ink-2";

  const handleAdd = () => {
    const stock: Stock = {
      ticker: cleanTicker,
      name: data.name || rawTicker,
      bucket: "Watchlist",
      sector: data.sector || "Technology",
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

  const stat = (label: string, value: React.ReactNode, cls = "text-ink") => (
    <div className="px-4 py-2.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={`mt-0.5 font-mono text-[13px] font-medium tabular-nums ${cls}`}>{value}</div>
    </div>
  );

  return (
    <div className="flex flex-col gap-3.5">
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2.5">
        <Link href="/screener" className={BTN}><AppIcon name="arrowL" size={13} strokeWidth={2} /> Screener</Link>
        <span className="text-[11.5px] text-ink-3">Scan preview · not yet in the book</span>
        <div className="ml-auto">
          {added || alreadyExists ? (
            <span className="inline-flex h-7 items-center gap-1.5 text-[12.5px] text-ink-3"><AppIcon name="check" size={13} strokeWidth={2} /> Added to Watchlist</span>
          ) : (
            <button onClick={handleAdd} className={BTN_PRI}>
              <AppIcon name="plus" size={13} strokeWidth={2.25} /> Add to Watchlist
            </button>
          )}
        </div>
      </div>

      {/* ── Header strip ── */}
      <section className="panel">
        <div className="panel-h">
          <span className="font-mono text-[15px] font-semibold text-ink">{rawTicker}</span>
          {data.name && data.name !== rawTicker && <span className="text-[12.5px] text-ink-2">{data.name}</span>}
          {data.sector && <span className="m">{data.sector}</span>}
        </div>
        <div className="grid grid-cols-2 divide-x divide-line-soft sm:grid-cols-5">
          {stat("Price", `$${data.price.toFixed(2)}`)}
          {stat("5d", pct(data.priceChange5d), data.priceChange5d >= 0 ? "text-pos" : "text-neg")}
          {stat("20d", pct(data.priceChange20d), data.priceChange20d >= 0 ? "text-pos" : "text-neg")}
          {stat("Composite technical", <>{net > 0 ? "+" : ""}{net} <span className="text-[11px] font-normal text-ink-3">{bullish} bullish · {bearish} bearish</span></>, compositeColor)}
          {stat("Improving", <>{imp.score}<span className="text-ink-faint">/6</span></>)}
        </div>
      </section>

      {/* Price Chart */}
      <StockChart ticker={rawTicker} technicals={data.technicals} />

      <div className="grid grid-cols-1 items-start gap-3.5 lg:grid-cols-2">
        {/* Improving Signals */}
        <section className="panel">
          <div className="panel-h">
            <span className="t">Improving signals</span>
            <span className="m"><span className="font-mono text-ink">{imp.score}</span>/6 active</span>
          </div>
          <table className="data-table">
            <thead><tr><th className="pl-3.5">Signal</th><th className="pr-3.5 text-right">State</th></tr></thead>
            <tbody>
              {imp.signals.map((s) => (
                <tr key={s.name}>
                  <td className="pl-3.5 text-ink-2">{s.name}</td>
                  <td className={`pr-3.5 text-right ${s.active ? "text-ink" : "text-ink-3"}`}>
                    <span className="inline-flex items-center gap-1.5"><span className={`dot ${s.active ? "bg-accent" : "bg-ink-faint"}`} />{s.active ? "Active" : "Inactive"}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {/* Technical Signals */}
        <section className="panel">
          <div className="panel-h"><span className="t">Technical signals</span><span className="m">6 reads</span></div>
          <table className="data-table">
            <thead><tr><th className="pl-3.5">Signal</th><th className="n">Reading</th><th className="pr-3.5 text-right">Read</th></tr></thead>
            <tbody>
              <SignalRow label="Trend (DMA)" signal={getTrendSignal()} detail={t.dmaSignal.replace(/_/g, " ")} />
              <SignalRow label="RSI (14)" signal={getRsiSignal()} detail={t.rsi14.toFixed(1)} />
              <SignalRow label="MACD" signal={getMacdSignal()} detail={`histogram ${t.macdHistogram >= 0 ? "+" : ""}${t.macdHistogram.toFixed(2)}`} />
              <SignalRow label="Ichimoku cloud" signal={getIchimokuSignal()} detail={t.ichimoku.overallSignal.replace(/_/g, " ")} />
              <SignalRow label="Volume" signal={getVolumeSignal()} detail={`${t.volumeRatio.toFixed(1)}x avg`} />
              <SignalRow label="52-week position" signal={getWeek52Signal()} detail={`${(t.week52Position * 100).toFixed(0)}%`} />
            </tbody>
          </table>
        </section>
      </div>

      {/* Key Levels */}
      <section className="panel">
        <div className="panel-h"><span className="t">Key levels</span></div>
        <div className="grid grid-cols-2 divide-x divide-line-soft md:grid-cols-4">
          {stat("SMA 50", `$${t.sma50.toFixed(2)}`)}
          {stat("SMA 200", `$${t.sma200.toFixed(2)}`)}
          {stat("52W high", `$${t.week52High.toFixed(2)}`)}
          {stat("52W low", `$${t.week52Low.toFixed(2)}`)}
        </div>
      </section>
    </div>
  );
}
