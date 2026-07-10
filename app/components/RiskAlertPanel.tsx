"use client";

import React from "react";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";

// ── Risk level banner ──

function RiskBanner({ alert }: { alert: RiskAlert }) {
  if (alert.level === "critical") {
    return (
      <div className="rounded-card bg-neg px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-neg-soft opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-neg-soft" />
          </span>
          <span className="text-sm font-bold uppercase tracking-wide">
            Critical Risk Alert — {alert.dangerCount} danger signals converging
          </span>
        </div>
        <p className="mt-2 text-sm text-neg-soft leading-relaxed">{alert.summary}</p>
      </div>
    );
  }

  if (alert.level === "warning") {
    return (
      <div className="rounded-card bg-warn px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-3 w-3 rounded-full bg-warn-soft" />
          <span className="text-sm font-bold uppercase tracking-wide">
            Elevated Risk — {alert.dangerCount} danger, {alert.cautionCount} caution signals
          </span>
        </div>
        <p className="mt-2 text-sm text-warn-soft leading-relaxed">{alert.summary}</p>
      </div>
    );
  }

  if (alert.level === "watch") {
    return (
      <div className="rounded-card bg-line px-5 py-3 text-ink-2">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-ink-3" />
          <span className="text-sm font-semibold">Watch — {alert.summary}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-card bg-pos-soft border border-pos-border px-5 py-3 text-pos">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-pos" />
        <span className="text-sm font-semibold">All Clear — {alert.summary}</span>
      </div>
    </div>
  );
}

// ── Signal card ──

function SignalCard({ signal }: { signal: RiskAlert["signals"][number] }) {
  const borderColor =
    signal.status === "danger"
      ? "border-l-neg"
      : signal.status === "caution"
      ? "border-l-warn"
      : "border-l-pos";

  const iconBg =
    signal.status === "danger"
      ? "bg-neg-soft text-neg"
      : signal.status === "caution"
      ? "bg-warn-soft text-warn"
      : "bg-pos-soft text-pos";

  const icon =
    signal.status === "danger" ? "!" : signal.status === "caution" ? "~" : "\u2713";

  return (
    <div className={`rounded-card border border-line border-l-4 ${borderColor} bg-white px-4 py-3`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${iconBg}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-ink">{signal.name}</div>
          <div className="text-xs text-ink-3 leading-relaxed mt-0.5">{signal.detail}</div>
        </div>
      </div>
    </div>
  );
}

// ── RSI Gauge ──

function RSIGauge({ rsi }: { rsi: number }) {
  const clampedRsi = Math.max(0, Math.min(100, rsi));
  const position = `${clampedRsi}%`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-ink-2">RSI (14)</span>
        <span className={`text-xs font-bold ${rsi > 70 ? "text-neg" : rsi < 30 ? "text-neg" : "text-pos"}`}>
          {rsi.toFixed(0)}
        </span>
      </div>
      <div className="relative h-3 rounded-full overflow-hidden">
        {/* Zones */}
        <div className="absolute inset-0 flex">
          <div className="w-[20%] bg-neg-soft" />
          <div className="w-[10%] bg-warn-soft" />
          <div className="w-[40%] bg-pos-soft" />
          <div className="w-[10%] bg-warn-soft" />
          <div className="w-[20%] bg-neg-soft" />
        </div>
        {/* Marker */}
        <div
          className="absolute top-0 h-3 w-1 bg-ink rounded-full"
          style={{ left: position, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] text-ink-3">0</span>
        <span className="text-[10px] text-ink-3">30</span>
        <span className="text-[10px] text-ink-3">70</span>
        <span className="text-[10px] text-ink-3">100</span>
      </div>
    </div>
  );
}

// ── MACD histogram bar ──

function MACDBar({ histogram, signal }: { histogram: number; signal: string }) {
  const maxAbsVal = Math.max(Math.abs(histogram), 0.01);
  const width = Math.min(100, (Math.abs(histogram) / maxAbsVal) * 100);
  const isPositive = histogram >= 0;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-ink-2">MACD Histogram</span>
        <span className={`text-xs font-bold ${isPositive ? "text-pos" : "text-neg"}`}>
          {histogram >= 0 ? "+" : ""}{histogram.toFixed(3)}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-surface-2 overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
        {isPositive ? (
          <div
            className="absolute inset-y-0 left-1/2 bg-pos rounded-r-full"
            style={{ width: `${width / 2}%` }}
          />
        ) : (
          <div
            className="absolute inset-y-0 bg-neg rounded-l-full"
            style={{ width: `${width / 2}%`, right: "50%" }}
          />
        )}
      </div>
      <div className="text-[10px] text-ink-3 mt-0.5">
        {signal.replace(/_/g, " ")}
      </div>
    </div>
  );
}

// ── Volume bar ──

function VolumeBar({ ratio, signal }: { ratio: number; signal: string }) {
  const clampedRatio = Math.min(3, ratio);
  const width = (clampedRatio / 3) * 100;
  const color = ratio > 1.5 ? "bg-warn" : ratio < 0.5 ? "bg-line" : "bg-accent";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-ink-2">Volume vs 50d Avg</span>
        <span className={`text-xs font-bold ${ratio > 1.5 ? "text-warn" : "text-ink-2"}`}>
          {ratio.toFixed(1)}x
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-surface-2 overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${width}%` }}
        />
        {/* 1x marker */}
        <div className="absolute inset-y-0 bg-ink-3" style={{ left: "33.3%", width: "1px" }} />
      </div>
      <div className="text-[10px] text-ink-3 mt-0.5">{signal.replace(/_/g, " ")}</div>
    </div>
  );
}

// ── Ichimoku Cloud panel ──

function IchimokuPanel({ ichimoku, price }: { ichimoku: TechnicalIndicators["ichimoku"]; price: number }) {
  const overallColor =
    ichimoku.overallSignal === "strong_bullish" || ichimoku.overallSignal === "bullish"
      ? "text-pos"
      : ichimoku.overallSignal === "strong_bearish" || ichimoku.overallSignal === "bearish"
      ? "text-neg"
      : "text-warn";

  const overallBg =
    ichimoku.overallSignal === "strong_bullish" || ichimoku.overallSignal === "bullish"
      ? "bg-pos-soft border-pos-border"
      : ichimoku.overallSignal === "strong_bearish" || ichimoku.overallSignal === "bearish"
      ? "bg-neg-soft border-neg-border"
      : "bg-warn-soft border-warn-border";

  const signalItems: { label: string; value: string; color: string }[] = [
    {
      label: "Price vs Cloud",
      value: ichimoku.priceVsCloud === "above" ? "Above (Bullish)" : ichimoku.priceVsCloud === "below" ? "Below (Bearish)" : "Inside (Indecision)",
      color: ichimoku.priceVsCloud === "above" ? "text-pos" : ichimoku.priceVsCloud === "below" ? "text-neg" : "text-warn",
    },
    {
      label: "TK Cross",
      value: ichimoku.tkCross === "bullish"
        ? `Bullish${ichimoku.tkCrossRecent ? " (Recent!)" : ""}`
        : ichimoku.tkCross === "bearish"
        ? `Bearish${ichimoku.tkCrossRecent ? " (Recent!)" : ""}`
        : "Neutral",
      color: ichimoku.tkCross === "bullish" ? "text-pos" : ichimoku.tkCross === "bearish" ? "text-neg" : "text-ink-3",
    },
    {
      label: "Cloud Trend",
      value: ichimoku.cloudTrend === "bullish" ? "Bullish" : ichimoku.cloudTrend === "bearish" ? "Bearish" : "Twisting (Trend Change)",
      color: ichimoku.cloudTrend === "bullish" ? "text-pos" : ichimoku.cloudTrend === "bearish" ? "text-neg" : "text-warn",
    },
    {
      label: "Chikou Span",
      value: ichimoku.chikouSignal === "bullish"
        ? `Bullish (+${ichimoku.chikouVsPrice.toFixed(1)}%)`
        : ichimoku.chikouSignal === "bearish"
        ? `Bearish (${ichimoku.chikouVsPrice.toFixed(1)}%)`
        : "Neutral",
      color: ichimoku.chikouSignal === "bullish" ? "text-pos" : ichimoku.chikouSignal === "bearish" ? "text-neg" : "text-ink-3",
    },
    {
      label: "Cloud Thickness",
      value: `${ichimoku.cloudThickness.toFixed(1)}%`,
      color: "text-ink-2",
    },
  ];

  return (
    <div>
      <div className="text-xs font-semibold text-ink-2 mb-1">Ichimoku Cloud</div>
      <div className={`rounded-card border p-3 ${overallBg}`}>
        <div className={`text-sm font-bold ${overallColor} mb-2`}>
          {ichimoku.overallSignal.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
        </div>
        {/* Cloud level visualization */}
        <div className="relative mb-3 h-12 rounded-lg bg-white/60 overflow-hidden">
          {/* Cloud band */}
          {(() => {
            const range = Math.max(price * 1.1, ichimoku.cloudTop * 1.05) - Math.min(price * 0.9, ichimoku.cloudBottom * 0.95);
            const base = Math.min(price * 0.9, ichimoku.cloudBottom * 0.95);
            const cloudBottomPct = range > 0 ? ((ichimoku.cloudBottom - base) / range) * 100 : 40;
            const cloudTopPct = range > 0 ? ((ichimoku.cloudTop - base) / range) * 100 : 60;
            const pricePct = range > 0 ? ((price - base) / range) * 100 : 50;
            const cloudColor = ichimoku.cloudTrend === "bullish" ? "bg-pos-soft/60" : ichimoku.cloudTrend === "bearish" ? "bg-neg-soft/60" : "bg-warn-soft/60";

            return (
              <>
                <div
                  className={`absolute left-0 right-0 ${cloudColor}`}
                  style={{ bottom: `${cloudBottomPct}%`, height: `${cloudTopPct - cloudBottomPct}%` }}
                />
                <div
                  className="absolute left-0 right-0 h-0.5 bg-ink"
                  style={{ bottom: `${pricePct}%` }}
                />
                <div
                  className="absolute right-2 text-[9px] font-bold text-ink-2"
                  style={{ bottom: `${pricePct}%`, transform: "translateY(50%)" }}
                >
                  ${price.toFixed(0)}
                </div>
              </>
            );
          })()}
        </div>
        <div className="space-y-1">
          {signalItems.map((item) => (
            <div key={item.label} className="flex items-center justify-between">
              <span className="text-[11px] text-ink-3">{item.label}</span>
              <span className={`text-[11px] font-semibold ${item.color}`}>{item.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── 52-week range ──

function Week52Range({ position, high, low }: { position: number; high: number; low: number }) {
  const pct = `${(Math.max(0, Math.min(1, position)) * 100).toFixed(0)}%`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-ink-2">52-Week Range</span>
        <span className="text-xs font-bold text-ink-2">{pct}</span>
      </div>
      <div className="relative h-3 rounded-full bg-gradient-to-r from-neg-soft via-line-soft to-pos-soft overflow-hidden">
        <div
          className="absolute top-0 h-3 w-1.5 bg-ink rounded-full"
          style={{ left: pct, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] text-ink-3">${low.toFixed(2)}</span>
        <span className="text-[10px] text-ink-3">${high.toFixed(2)}</span>
      </div>
    </div>
  );
}

// ── Main component ──

export default function RiskAlertPanel({
  riskAlert,
  technicals,
}: {
  riskAlert: RiskAlert;
  technicals: TechnicalIndicators;
}) {
  // Sort signals: danger first, then caution, then ok
  const sortedSignals = [...riskAlert.signals].sort((a, b) => {
    const order = { danger: 0, caution: 1, ok: 2 };
    return order[a.status] - order[b.status];
  });

  return (
    <div className="mt-6">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-ink">Risk Alert</h2>
        <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${
          riskAlert.level === "critical"
            ? "bg-neg-soft text-neg"
            : riskAlert.level === "warning"
            ? "bg-warn-soft text-warn"
            : riskAlert.level === "watch"
            ? "bg-surface-2 text-ink-2"
            : "bg-pos-soft text-pos"
        }`}>
          {riskAlert.level.toUpperCase()}
        </span>
      </div>

      {/* Risk Banner */}
      <RiskBanner alert={riskAlert} />

      {/* Signal Grid */}
      <div className="grid gap-3 md:grid-cols-2 mt-4">
        {sortedSignals.map((signal, i) => (
          <SignalCard key={i} signal={signal} />
        ))}
      </div>

      {/* Higher-timeframe readout (informational — not contributing to
          risk alert; present so user can see daily + weekly + monthly
          at a glance for Newton-style multi-TF confluence). */}
      {(technicals.weeklyMacd || technicals.monthlyMacd || technicals.weeklyRsi != null || technicals.monthlyRsi != null) && (
        <div className="mt-5 rounded-card border border-line bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-bold text-ink-2">Higher Timeframes</h3>
            <span className="rounded-full bg-surface-2 px-2.5 py-0.5 text-[10px] font-medium text-ink-3">Informational</span>
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            {/* Daily column */}
            <div className="rounded-card border border-line bg-surface-2 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-2">Daily</div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">RSI</span>
                <span className={`font-bold font-mono ${technicals.rsi14 > 70 ? "text-neg" : technicals.rsi14 < 30 ? "text-neg" : technicals.rsi14 > 50 ? "text-pos" : "text-ink-2"}`}>
                  {technicals.rsi14.toFixed(0)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">MACD</span>
                <span className={`font-bold ${technicals.macdLine >= technicals.signalLine ? "text-pos" : "text-neg"}`}>
                  {technicals.macdLine >= technicals.signalLine ? "Bullish" : "Bearish"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">Hist.</span>
                <span className={`font-mono ${technicals.macdHistogram >= 0 ? "text-pos" : "text-neg"}`}>
                  {technicals.macdHistogram >= 0 ? "+" : ""}{technicals.macdHistogram.toFixed(2)}
                </span>
              </div>
            </div>
            {/* Weekly column */}
            <div className="rounded-card border border-line bg-surface-2 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-2">Weekly</div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">RSI</span>
                <span className={`font-bold font-mono ${
                  technicals.weeklyRsi == null ? "text-ink-3"
                    : technicals.weeklyRsi > 70 || technicals.weeklyRsi < 30 ? "text-neg"
                    : technicals.weeklyRsi > 50 ? "text-pos" : "text-ink-2"
                }`}>
                  {technicals.weeklyRsi != null ? technicals.weeklyRsi.toFixed(0) : "\u2014"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">MACD</span>
                <span className={`font-bold ${
                  !technicals.weeklyMacd ? "text-ink-3"
                    : technicals.weeklyMacd.signal === "bullish" ? "text-pos" : "text-neg"
                }`}>
                  {technicals.weeklyMacd ? (technicals.weeklyMacd.signal === "bullish" ? "Bullish" : "Bearish") : "\u2014"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">Hist.</span>
                <span className={`font-mono ${
                  !technicals.weeklyMacd ? "text-ink-3"
                    : technicals.weeklyMacd.histogram >= 0 ? "text-pos" : "text-neg"
                }`}>
                  {technicals.weeklyMacd ? `${technicals.weeklyMacd.histogram >= 0 ? "+" : ""}${technicals.weeklyMacd.histogram.toFixed(2)}` : "\u2014"}
                </span>
              </div>
            </div>
            {/* Monthly column */}
            <div className="rounded-card border border-line bg-surface-2 px-4 py-3">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 mb-2">Monthly</div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">RSI</span>
                <span className={`font-bold font-mono ${
                  technicals.monthlyRsi == null ? "text-ink-3"
                    : technicals.monthlyRsi > 70 || technicals.monthlyRsi < 30 ? "text-neg"
                    : technicals.monthlyRsi > 50 ? "text-pos" : "text-ink-2"
                }`}>
                  {technicals.monthlyRsi != null ? technicals.monthlyRsi.toFixed(0) : "\u2014"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">MACD</span>
                <span className={`font-bold ${
                  !technicals.monthlyMacd ? "text-ink-3"
                    : technicals.monthlyMacd.signal === "bullish" ? "text-pos" : "text-neg"
                }`}>
                  {technicals.monthlyMacd ? (technicals.monthlyMacd.signal === "bullish" ? "Bullish" : "Bearish") : "\u2014"}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-ink-2">Hist.</span>
                <span className={`font-mono ${
                  !technicals.monthlyMacd ? "text-ink-3"
                    : technicals.monthlyMacd.histogram >= 0 ? "text-pos" : "text-neg"
                }`}>
                  {technicals.monthlyMacd ? `${technicals.monthlyMacd.histogram >= 0 ? "+" : ""}${technicals.monthlyMacd.histogram.toFixed(2)}` : "\u2014"}
                </span>
              </div>
            </div>
          </div>
          <p className="mt-3 text-[11px] text-ink-3">
            Higher-timeframe confluence: when daily + weekly + monthly RSI all agree (all {">"} 50 or all {"<"} 50), the trend is more durable.
          </p>
        </div>
      )}

      {/* Technical Chart Indicators */}
      <div className="mt-5 rounded-card border border-line bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold text-ink-2 mb-4">Technical Indicators</h3>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <RSIGauge rsi={technicals.rsi14} />
          <MACDBar histogram={technicals.macdHistogram} signal={technicals.macdSignal} />
          <VolumeBar ratio={technicals.volumeRatio} signal={technicals.volumeSignal} />
          <Week52Range
            position={technicals.week52Position}
            high={technicals.week52High}
            low={technicals.week52Low}
          />
          {/* Ichimoku Cloud */}
          <IchimokuPanel ichimoku={technicals.ichimoku} price={technicals.currentPrice} />
          {/* Price changes summary */}
          <div>
            <div className="text-xs font-semibold text-ink-2 mb-1">Price Momentum</div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-3">5-day</span>
                <span className={`text-xs font-bold ${technicals.priceChange5d >= 0 ? "text-pos" : "text-neg"}`}>
                  {technicals.priceChange5d >= 0 ? "+" : ""}{technicals.priceChange5d.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-3">20-day</span>
                <span className={`text-xs font-bold ${technicals.priceChange20d >= 0 ? "text-pos" : "text-neg"}`}>
                  {technicals.priceChange20d >= 0 ? "+" : ""}{technicals.priceChange20d.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-ink-3">DMA Signal</span>
                <span className={`text-xs font-bold ${
                  technicals.dmaSignal === "above_both" || technicals.dmaSignal === "golden_cross"
                    ? "text-pos"
                    : technicals.dmaSignal === "below_both" || technicals.dmaSignal === "death_cross"
                    ? "text-neg"
                    : "text-warn"
                }`}>
                  {technicals.dmaSignal.replace(/_/g, " ")}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
