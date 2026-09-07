"use client";

import React from "react";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { AppIcon } from "@/app/components/AppIcon";

/**
 * Risk alert — the deterministic technical risk read (level + converging
 * signals + indicator gauges + higher-timeframe confluence). Renders as a
 * flush row-set inside the stock page's "Risk & factors" panel: a one-line
 * level read plus condensed label/value rows are always visible; the full
 * signal list, gauges and higher-timeframe table sit one persisted click
 * away (`stock.riskAlert.open`).
 */

const LEVEL: Record<RiskAlert["level"], { dot: string; text: string; word: string }> = {
  critical: { dot: "bg-neg", text: "text-neg", word: "Critical" },
  warning: { dot: "bg-warn", text: "text-warn", word: "Elevated" },
  watch: { dot: "bg-ink-3", text: "text-ink-2", word: "Watch" },
  clear: { dot: "bg-pos", text: "text-pos", word: "All clear" },
};

const STATUS_DOT: Record<"danger" | "caution" | "ok", string> = {
  danger: "bg-neg",
  caution: "bg-warn",
  ok: "bg-pos",
};

function Kv({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-[12px]">
      <span className="text-ink-2">{label}</span>
      <span className={`font-mono font-medium ${tone ?? "text-ink"}`}>{value}</span>
    </div>
  );
}

function signed(n: number, decimals = 1, suffix = ""): string {
  return `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(decimals)}${suffix}`;
}

/** Thin 4px bar with a marker — the one gauge shape. */
function Gauge({ label, value, pct, marker, tone, foot }: {
  label: string;
  value: React.ReactNode;
  /** Fill width 0-100, or null for a marker-only track. */
  pct: number | null;
  /** Marker position 0-100 (optional). */
  marker?: number;
  tone?: string;
  foot?: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-[12px]">
        <span className="text-ink-2">{label}</span>
        <span className={`font-mono font-medium ${tone ?? "text-ink"}`}>{value}</span>
      </div>
      <div className="relative h-1 overflow-visible rounded-sm bg-line-soft">
        {pct != null && <div className="h-full rounded-sm bg-ink-2" style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />}
        {marker != null && (
          <div className="absolute -top-[2px] h-2 w-[2px] rounded-sm bg-ink" style={{ left: `${Math.max(0, Math.min(100, marker))}%`, transform: "translateX(-50%)" }} />
        )}
      </div>
      {foot && <div className="mt-1 flex justify-between font-mono text-[10.5px] text-ink-3">{foot}</div>}
    </div>
  );
}

function macdWord(t: TechnicalIndicators) {
  return t.macdLine >= t.signalLine ? "Bullish" : "Bearish";
}

export default function RiskAlertPanel({
  riskAlert,
  technicals,
  className = "",
}: {
  riskAlert: RiskAlert;
  technicals: TechnicalIndicators;
  className?: string;
}) {
  const [open, toggleOpen] = usePersistedOpen("stock.riskAlert.open", false);
  const lvl = LEVEL[riskAlert.level];

  // Sort signals: danger first, then caution, then ok
  const sortedSignals = [...riskAlert.signals].sort((a, b) => {
    const order = { danger: 0, caution: 1, ok: 2 };
    return order[a.status] - order[b.status];
  });

  const rsi = technicals.rsi14;
  const rsiTone = rsi > 70 || rsi < 30 ? "text-neg" : rsi > 50 ? "text-pos" : "text-ink";
  const ich = technicals.ichimoku;
  const ichWord = ich.overallSignal.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const ichTone = ich.overallSignal.includes("bullish") ? "text-pos" : ich.overallSignal.includes("bearish") ? "text-neg" : "text-warn";
  const dmaTone =
    technicals.dmaSignal === "above_both" || technicals.dmaSignal === "golden_cross" ? "text-pos"
    : technicals.dmaSignal === "below_both" || technicals.dmaSignal === "death_cross" ? "text-neg"
    : "text-warn";

  const hasHigherTf = technicals.weeklyMacd || technicals.monthlyMacd || technicals.weeklyRsi != null || technicals.monthlyRsi != null;

  const tfRow = (label: string, rsiV: number | null | undefined, macd: { signal: string; histogram: number } | null | undefined) => (
    <tr key={label}>
      <td className="pl-0">{label}</td>
      <td className={`n ${rsiV == null ? "text-ink-3" : rsiV > 70 || rsiV < 30 ? "text-neg" : rsiV > 50 ? "text-pos" : ""}`}>{rsiV != null ? rsiV.toFixed(0) : "—"}</td>
      <td className={`n ${!macd ? "text-ink-3" : macd.signal === "bullish" ? "text-pos" : "text-neg"}`}>{macd ? (macd.signal === "bullish" ? "Bullish" : "Bearish") : "—"}</td>
      <td className={`n ${!macd ? "text-ink-3" : macd.histogram >= 0 ? "text-pos" : "text-neg"}`}>{macd ? signed(macd.histogram, 2) : "—"}</td>
    </tr>
  );

  return (
    <div className={className}>
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-ink">Risk alert</span>
        <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${lvl.text}`}>
          <span className={`dot ${lvl.dot}`} /> {lvl.word}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px] text-ink-3" title={riskAlert.summary}>{riskAlert.summary}</span>
        <button
          onClick={toggleOpen}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink"
          aria-expanded={open}
          aria-label={open ? "Hide risk signals" : "Show risk signals"}
          title={open ? "Hide risk signals and indicators" : "Show risk signals and indicators"}
        >
          <AppIcon name={open ? "chevU" : "chevD"} size={14} />
        </button>
      </div>

      <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5">
        <Kv label="Signals" value={`${riskAlert.dangerCount} danger · ${riskAlert.cautionCount} caution`} tone={riskAlert.dangerCount > 0 ? "text-neg" : riskAlert.cautionCount > 0 ? "text-warn" : "text-ink"} />
        <Kv label="RSI (14)" value={rsi.toFixed(0)} tone={rsiTone} />
        <Kv label="MACD" value={macdWord(technicals)} tone={technicals.macdLine >= technicals.signalLine ? "text-pos" : "text-neg"} />
        <Kv label="DMA" value={technicals.dmaSignal.replace(/_/g, " ")} tone={dmaTone} />
        <Kv label="52-week position" value={`${(Math.max(0, Math.min(1, technicals.week52Position)) * 100).toFixed(0)}%`} />
        <Kv label="Ichimoku" value={ichWord} tone={ichTone} />
      </div>

      {open && (
        <div className="mt-3 border-t border-line-soft pt-3">
          {/* Signals */}
          <div className="flex flex-col gap-1.5">
            {sortedSignals.map((signal, i) => (
              <div key={i} className="flex items-start gap-2 text-[12px]">
                <span className={`dot mt-[6px] ${STATUS_DOT[signal.status]}`} />
                <span className="font-medium text-ink">{signal.name}</span>
                <span className="min-w-0 flex-1 text-ink-3">{signal.detail}</span>
              </div>
            ))}
          </div>

          {/* Indicators */}
          <div className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2">
            <Gauge
              label="RSI (14)"
              value={rsi.toFixed(0)}
              pct={null}
              marker={Math.max(0, Math.min(100, rsi))}
              tone={rsiTone}
              foot={<><span>0</span><span>30</span><span>70</span><span>100</span></>}
            />
            <Gauge
              label="MACD histogram"
              value={signed(technicals.macdHistogram, 3)}
              pct={null}
              marker={50 + Math.max(-50, Math.min(50, (technicals.macdHistogram / Math.max(Math.abs(technicals.macdHistogram), 0.01)) * 50))}
              tone={technicals.macdHistogram >= 0 ? "text-pos" : "text-neg"}
              foot={<span>{technicals.macdSignal.replace(/_/g, " ")}</span>}
            />
            <Gauge
              label="Volume vs 50d avg"
              value={`${technicals.volumeRatio.toFixed(1)}x`}
              pct={(Math.min(3, technicals.volumeRatio) / 3) * 100}
              marker={33.3}
              tone={technicals.volumeRatio > 1.5 ? "text-warn" : "text-ink"}
              foot={<span>{technicals.volumeSignal.replace(/_/g, " ")}</span>}
            />
            <Gauge
              label="52-week range"
              value={`${(Math.max(0, Math.min(1, technicals.week52Position)) * 100).toFixed(0)}%`}
              pct={null}
              marker={Math.max(0, Math.min(1, technicals.week52Position)) * 100}
              foot={<><span>{technicals.week52Low.toFixed(2)}</span><span>{technicals.week52High.toFixed(2)}</span></>}
            />
            {/* Ichimoku */}
            <div>
              <div className="mb-1 flex items-baseline justify-between text-[12px]">
                <span className="text-ink-2">Ichimoku cloud</span>
                <span className={`font-mono font-medium ${ichTone}`}>{ichWord}</span>
              </div>
              <div className="flex flex-col gap-1 text-[11.5px]">
                <Kv label="Price vs cloud" value={ich.priceVsCloud === "above" ? "Above" : ich.priceVsCloud === "below" ? "Below" : "Inside"} tone={ich.priceVsCloud === "above" ? "text-pos" : ich.priceVsCloud === "below" ? "text-neg" : "text-warn"} />
                <Kv label="TK cross" value={ich.tkCross === "bullish" ? `Bullish${ich.tkCrossRecent ? " · recent" : ""}` : ich.tkCross === "bearish" ? `Bearish${ich.tkCrossRecent ? " · recent" : ""}` : "Neutral"} tone={ich.tkCross === "bullish" ? "text-pos" : ich.tkCross === "bearish" ? "text-neg" : "text-ink-3"} />
                <Kv label="Cloud trend" value={ich.cloudTrend === "bullish" ? "Bullish" : ich.cloudTrend === "bearish" ? "Bearish" : "Twisting"} tone={ich.cloudTrend === "bullish" ? "text-pos" : ich.cloudTrend === "bearish" ? "text-neg" : "text-warn"} />
                <Kv label="Chikou span" value={ich.chikouSignal === "bullish" ? `Bullish ${signed(ich.chikouVsPrice, 1, "%")}` : ich.chikouSignal === "bearish" ? `Bearish ${signed(ich.chikouVsPrice, 1, "%")}` : "Neutral"} tone={ich.chikouSignal === "bullish" ? "text-pos" : ich.chikouSignal === "bearish" ? "text-neg" : "text-ink-3"} />
                <Kv label="Cloud thickness" value={`${ich.cloudThickness.toFixed(1)}%`} />
                <Kv label="Cloud" value={`${ich.cloudBottom.toFixed(2)} – ${ich.cloudTop.toFixed(2)} · px ${technicals.currentPrice.toFixed(2)}`} />
              </div>
            </div>
            {/* Price momentum */}
            <div>
              <div className="mb-1 text-[12px] text-ink-2">Price momentum</div>
              <div className="flex flex-col gap-1 text-[11.5px]">
                <Kv label="5-day" value={signed(technicals.priceChange5d, 1, "%")} tone={technicals.priceChange5d >= 0 ? "text-pos" : "text-neg"} />
                <Kv label="20-day" value={signed(technicals.priceChange20d, 1, "%")} tone={technicals.priceChange20d >= 0 ? "text-pos" : "text-neg"} />
                <Kv label="DMA signal" value={technicals.dmaSignal.replace(/_/g, " ")} tone={dmaTone} />
              </div>
            </div>
          </div>

          {/* Higher-timeframe readout (informational — not contributing to
              risk alert; present so user can see daily + weekly + monthly
              at a glance for Newton-style multi-TF confluence). */}
          {hasHigherTf && (
            <div className="mt-4">
              <div className="mb-1 flex items-baseline gap-2 text-[12px]">
                <span className="text-ink-2">Higher timeframes</span>
                <span className="text-[11px] text-ink-3">informational</span>
              </div>
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="pl-0">Frame</th>
                    <th className="n">RSI</th>
                    <th className="n">MACD</th>
                    <th className="n">Hist.</th>
                  </tr>
                </thead>
                <tbody>
                  {tfRow("Daily", technicals.rsi14, { signal: technicals.macdLine >= technicals.signalLine ? "bullish" : "bearish", histogram: technicals.macdHistogram })}
                  {tfRow("Weekly", technicals.weeklyRsi, technicals.weeklyMacd)}
                  {tfRow("Monthly", technicals.monthlyRsi, technicals.monthlyMacd)}
                </tbody>
              </table>
              <p className="mt-2 text-[11px] text-ink-3">
                Higher-timeframe confluence: when daily + weekly + monthly RSI all agree (all {">"} 50 or all {"<"} 50), the trend is more durable.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
