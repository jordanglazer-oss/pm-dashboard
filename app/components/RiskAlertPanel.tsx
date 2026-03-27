"use client";

import React from "react";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";

// ── Risk level banner ──

function RiskBanner({ alert }: { alert: RiskAlert }) {
  if (alert.level === "critical") {
    return (
      <div className="rounded-2xl bg-red-600 px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-300 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-red-100" />
          </span>
          <span className="text-sm font-bold uppercase tracking-wide">
            Critical Risk Alert — {alert.dangerCount} danger signals converging
          </span>
        </div>
        <p className="mt-2 text-sm text-red-100 leading-relaxed">{alert.summary}</p>
      </div>
    );
  }

  if (alert.level === "warning") {
    return (
      <div className="rounded-2xl bg-amber-500 px-5 py-4 text-white">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-3 w-3 rounded-full bg-amber-200" />
          <span className="text-sm font-bold uppercase tracking-wide">
            Elevated Risk — {alert.dangerCount} danger, {alert.cautionCount} caution signals
          </span>
        </div>
        <p className="mt-2 text-sm text-amber-100 leading-relaxed">{alert.summary}</p>
      </div>
    );
  }

  if (alert.level === "watch") {
    return (
      <div className="rounded-2xl bg-slate-200 px-5 py-3 text-slate-700">
        <div className="flex items-center gap-3">
          <span className="inline-flex h-2.5 w-2.5 rounded-full bg-slate-400" />
          <span className="text-sm font-semibold">Watch — {alert.summary}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-2xl bg-emerald-50 border border-emerald-200 px-5 py-3 text-emerald-700">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
        <span className="text-sm font-semibold">All Clear — {alert.summary}</span>
      </div>
    </div>
  );
}

// ── Signal card ──

function SignalCard({ signal }: { signal: RiskAlert["signals"][number] }) {
  const borderColor =
    signal.status === "danger"
      ? "border-l-red-500"
      : signal.status === "caution"
      ? "border-l-amber-500"
      : "border-l-emerald-500";

  const iconBg =
    signal.status === "danger"
      ? "bg-red-100 text-red-600"
      : signal.status === "caution"
      ? "bg-amber-100 text-amber-600"
      : "bg-emerald-100 text-emerald-600";

  const icon =
    signal.status === "danger" ? "!" : signal.status === "caution" ? "~" : "\u2713";

  return (
    <div className={`rounded-xl border border-slate-200 border-l-4 ${borderColor} bg-white px-4 py-3`}>
      <div className="flex items-start gap-3">
        <div className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${iconBg}`}>
          {icon}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-800">{signal.name}</div>
          <div className="text-xs text-slate-500 leading-relaxed mt-0.5">{signal.detail}</div>
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
        <span className="text-xs font-semibold text-slate-600">RSI (14)</span>
        <span className={`text-xs font-bold ${rsi > 70 ? "text-red-600" : rsi < 30 ? "text-red-600" : "text-emerald-600"}`}>
          {rsi.toFixed(0)}
        </span>
      </div>
      <div className="relative h-3 rounded-full overflow-hidden">
        {/* Zones */}
        <div className="absolute inset-0 flex">
          <div className="w-[20%] bg-red-200" />
          <div className="w-[10%] bg-amber-200" />
          <div className="w-[40%] bg-emerald-200" />
          <div className="w-[10%] bg-amber-200" />
          <div className="w-[20%] bg-red-200" />
        </div>
        {/* Marker */}
        <div
          className="absolute top-0 h-3 w-1 bg-slate-800 rounded-full"
          style={{ left: position, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] text-slate-400">0</span>
        <span className="text-[10px] text-slate-400">30</span>
        <span className="text-[10px] text-slate-400">70</span>
        <span className="text-[10px] text-slate-400">100</span>
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
        <span className="text-xs font-semibold text-slate-600">MACD Histogram</span>
        <span className={`text-xs font-bold ${isPositive ? "text-emerald-600" : "text-red-600"}`}>
          {histogram >= 0 ? "+" : ""}{histogram.toFixed(3)}
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-slate-100 overflow-hidden">
        <div className="absolute inset-y-0 left-1/2 w-px bg-slate-300" />
        {isPositive ? (
          <div
            className="absolute inset-y-0 left-1/2 bg-emerald-400 rounded-r-full"
            style={{ width: `${width / 2}%` }}
          />
        ) : (
          <div
            className="absolute inset-y-0 bg-red-400 rounded-l-full"
            style={{ width: `${width / 2}%`, right: "50%" }}
          />
        )}
      </div>
      <div className="text-[10px] text-slate-400 mt-0.5">
        {signal.replace(/_/g, " ")}
      </div>
    </div>
  );
}

// ── Bollinger position ──

function BollingerPosition({ position, upper, lower, price }: { position: number; upper: number; lower: number; price: number }) {
  const pct = `${(Math.max(0, Math.min(1, position)) * 100).toFixed(0)}%`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-600">Bollinger Position</span>
        <span className="text-xs font-bold text-slate-700">{pct}</span>
      </div>
      <div className="relative h-3 rounded-full bg-gradient-to-r from-blue-200 via-slate-100 to-blue-200 overflow-hidden">
        <div
          className="absolute top-0 h-3 w-1.5 bg-slate-800 rounded-full"
          style={{ left: pct, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] text-slate-400">${lower.toFixed(0)}</span>
        <span className="text-[10px] text-slate-500 font-medium">${price.toFixed(2)}</span>
        <span className="text-[10px] text-slate-400">${upper.toFixed(0)}</span>
      </div>
    </div>
  );
}

// ── Volume bar ──

function VolumeBar({ ratio, signal }: { ratio: number; signal: string }) {
  const clampedRatio = Math.min(3, ratio);
  const width = (clampedRatio / 3) * 100;
  const color = ratio > 1.5 ? "bg-amber-400" : ratio < 0.5 ? "bg-slate-300" : "bg-blue-400";

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-600">Volume vs 50d Avg</span>
        <span className={`text-xs font-bold ${ratio > 1.5 ? "text-amber-600" : "text-slate-700"}`}>
          {ratio.toFixed(1)}x
        </span>
      </div>
      <div className="relative h-3 rounded-full bg-slate-100 overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${width}%` }}
        />
        {/* 1x marker */}
        <div className="absolute inset-y-0 bg-slate-400" style={{ left: "33.3%", width: "1px" }} />
      </div>
      <div className="text-[10px] text-slate-400 mt-0.5">{signal.replace(/_/g, " ")}</div>
    </div>
  );
}

// ── 52-week range ──

function Week52Range({ position, high, low }: { position: number; high: number; low: number }) {
  const pct = `${(Math.max(0, Math.min(1, position)) * 100).toFixed(0)}%`;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-semibold text-slate-600">52-Week Range</span>
        <span className="text-xs font-bold text-slate-700">{pct}</span>
      </div>
      <div className="relative h-3 rounded-full bg-gradient-to-r from-red-200 via-slate-100 to-emerald-200 overflow-hidden">
        <div
          className="absolute top-0 h-3 w-1.5 bg-slate-800 rounded-full"
          style={{ left: pct, transform: "translateX(-50%)" }}
        />
      </div>
      <div className="flex justify-between mt-0.5">
        <span className="text-[10px] text-slate-400">${low.toFixed(2)}</span>
        <span className="text-[10px] text-slate-400">${high.toFixed(2)}</span>
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
        <h2 className="text-lg font-bold text-slate-800">Risk Alert</h2>
        <span className={`rounded-full px-3 py-0.5 text-xs font-semibold ${
          riskAlert.level === "critical"
            ? "bg-red-100 text-red-700"
            : riskAlert.level === "warning"
            ? "bg-amber-100 text-amber-700"
            : riskAlert.level === "watch"
            ? "bg-slate-100 text-slate-600"
            : "bg-emerald-100 text-emerald-700"
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

      {/* Technical Chart Indicators */}
      <div className="mt-5 rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
        <h3 className="text-sm font-bold text-slate-700 mb-4">Technical Indicators</h3>
        <div className="grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          <RSIGauge rsi={technicals.rsi14} />
          <MACDBar histogram={technicals.macdHistogram} signal={technicals.macdSignal} />
          <BollingerPosition
            position={technicals.bollingerPosition}
            upper={technicals.bollingerUpper}
            lower={technicals.bollingerLower}
            price={technicals.currentPrice}
          />
          <VolumeBar ratio={technicals.volumeRatio} signal={technicals.volumeSignal} />
          <Week52Range
            position={technicals.week52Position}
            high={technicals.week52High}
            low={technicals.week52Low}
          />
          {/* Price changes summary */}
          <div>
            <div className="text-xs font-semibold text-slate-600 mb-1">Price Momentum</div>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">5-day</span>
                <span className={`text-xs font-bold ${technicals.priceChange5d >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {technicals.priceChange5d >= 0 ? "+" : ""}{technicals.priceChange5d.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">20-day</span>
                <span className={`text-xs font-bold ${technicals.priceChange20d >= 0 ? "text-emerald-600" : "text-red-600"}`}>
                  {technicals.priceChange20d >= 0 ? "+" : ""}{technicals.priceChange20d.toFixed(1)}%
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-slate-500">DMA Signal</span>
                <span className={`text-xs font-bold ${
                  technicals.dmaSignal === "above_both" || technicals.dmaSignal === "golden_cross"
                    ? "text-emerald-600"
                    : technicals.dmaSignal === "below_both" || technicals.dmaSignal === "death_cross"
                    ? "text-red-600"
                    : "text-amber-600"
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
