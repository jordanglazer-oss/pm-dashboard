"use client";

import React from "react";
import type { HealthData } from "@/app/lib/types";

// ── Helpers ──

function fmt(val: number | undefined, decimals = 1, suffix = ""): string {
  if (val == null || !isFinite(val)) return "\u2014";
  return `${val.toFixed(decimals)}${suffix}`;
}

function pctDistance(price: number | undefined, avg: number | undefined): string {
  if (price == null || avg == null || avg === 0) return "\u2014";
  const pct = ((price - avg) / avg) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function aboveBelow(price: number | undefined, avg: number | undefined): "above" | "below" | null {
  if (price == null || avg == null) return null;
  return price >= avg ? "above" : "below";
}

function signalColor(signal: "green" | "red" | "neutral"): string {
  if (signal === "green") return "text-emerald-600";
  if (signal === "red") return "text-red-600";
  return "text-slate-500";
}

// ── Category theme configs ──

type CategoryConfig = {
  title: string;
  subtitle: string;
  borderColor: string;
  headerBg: string;
  headerText: string;
};

const CATEGORIES: CategoryConfig[] = [
  {
    title: "Price & Technical",
    subtitle: "Moving averages & relative strength",
    borderColor: "border-l-blue-600",
    headerBg: "bg-blue-600",
    headerText: "text-white",
  },
  {
    title: "Fundamental Quality",
    subtitle: "Earnings revisions, FCF & returns",
    borderColor: "border-l-teal-600",
    headerBg: "bg-teal-600",
    headerText: "text-white",
  },
  {
    title: "Valuation vs History",
    subtitle: "P/E, PEG & EV/EBITDA",
    borderColor: "border-l-green-600",
    headerBg: "bg-green-600",
    headerText: "text-white",
  },
  {
    title: "Ownership & Positioning",
    subtitle: "Institutional, insider & short interest",
    borderColor: "border-l-purple-600",
    headerBg: "bg-purple-600",
    headerText: "text-white",
  },
  {
    title: "Catalyst Calendar",
    subtitle: "Upcoming events & dates",
    borderColor: "border-l-amber-700",
    headerBg: "bg-amber-700",
    headerText: "text-white",
  },
];

// ── Indicator row ──

function IndicatorRow({ label, value, signal = "neutral" }: { label: string; value: string; signal?: "green" | "red" | "neutral" }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-b-0">
      <span className="text-sm text-slate-600">{label}</span>
      <span className={`text-sm font-semibold ${signalColor(signal)}`}>{value}</span>
    </div>
  );
}

// ── Category card ──

function CategoryCard({ config, children }: { config: CategoryConfig; children: React.ReactNode }) {
  return (
    <div className={`rounded-[24px] border border-slate-200 bg-white shadow-sm overflow-hidden border-l-4 ${config.borderColor}`}>
      <div className={`${config.headerBg} px-5 py-3`}>
        <h3 className={`text-sm font-bold ${config.headerText}`}>{config.title}</h3>
        <p className="text-xs text-white/70">{config.subtitle}</p>
      </div>
      <div className="px-5 py-3">
        {children}
      </div>
    </div>
  );
}

// ── Main component ──

export default function StockHealthMonitor({ healthData }: { healthData: HealthData }) {
  const price = healthData.currentPrice;

  // Price & Technical signals
  const fiftyDmaSignal = aboveBelow(price, healthData.fiftyDayAvg);
  const twoHundredDmaSignal = aboveBelow(price, healthData.twoHundredDayAvg);

  // Earnings revision signal
  let earningsRevSignal: "green" | "red" | "neutral" = "neutral";
  if (healthData.earningsCurrentEst != null && healthData.earnings30dAgo != null) {
    earningsRevSignal = healthData.earningsCurrentEst > healthData.earnings30dAgo ? "green" : healthData.earningsCurrentEst < healthData.earnings30dAgo ? "red" : "neutral";
  }

  // PEG signal
  let pegSignal: "green" | "red" | "neutral" = "neutral";
  if (healthData.pegRatio != null) {
    pegSignal = healthData.pegRatio < 1.5 ? "green" : healthData.pegRatio > 2.5 ? "red" : "neutral";
  }

  // Short interest signal
  let shortSignal: "green" | "red" | "neutral" = "neutral";
  if (healthData.shortPercentOfFloat != null) {
    shortSignal = healthData.shortPercentOfFloat > 10 ? "red" : "neutral";
  }

  // FCF margin signal
  let fcfSignal: "green" | "red" | "neutral" = "neutral";
  if (healthData.fcfMargin != null) {
    fcfSignal = healthData.fcfMargin > 15 ? "green" : healthData.fcfMargin < 5 ? "red" : "neutral";
  }

  // Earnings revision direction text
  let revisionText = "\u2014";
  if (healthData.earningsCurrentEst != null && healthData.earnings30dAgo != null) {
    const diff = healthData.earningsCurrentEst - healthData.earnings30dAgo;
    const arrow = diff > 0 ? "\u2191" : diff < 0 ? "\u2193" : "\u2192";
    revisionText = `$${healthData.earningsCurrentEst.toFixed(2)} ${arrow} (30d ago: $${healthData.earnings30dAgo.toFixed(2)})`;
  }

  let revision90Text: string | null = null;
  if (healthData.earningsCurrentEst != null && healthData.earnings90dAgo != null) {
    const diff90 = healthData.earningsCurrentEst - healthData.earnings90dAgo;
    const arrow90 = diff90 > 0 ? "\u2191" : diff90 < 0 ? "\u2193" : "\u2192";
    revision90Text = `$${healthData.earningsCurrentEst.toFixed(2)} ${arrow90} (90d ago: $${healthData.earnings90dAgo.toFixed(2)})`;
  }

  return (
    <div className="mt-6">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-lg font-bold text-slate-800">Stock Health Monitor</h2>
        <span className="rounded-full bg-slate-100 px-3 py-0.5 text-xs font-medium text-slate-500">Informational Only</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {/* Price & Technical */}
        <CategoryCard config={CATEGORIES[0]}>
          <IndicatorRow
            label="50-Day MA"
            value={healthData.fiftyDayAvg != null
              ? `${fiftyDmaSignal === "above" ? "Above" : "Below"} (${fmt(healthData.fiftyDayAvg, 2)}) ${pctDistance(price, healthData.fiftyDayAvg)}`
              : "\u2014"}
            signal={fiftyDmaSignal === "above" ? "green" : fiftyDmaSignal === "below" ? "red" : "neutral"}
          />
          <IndicatorRow
            label="200-Day MA"
            value={healthData.twoHundredDayAvg != null
              ? `${twoHundredDmaSignal === "above" ? "Above" : "Below"} (${fmt(healthData.twoHundredDayAvg, 2)}) ${pctDistance(price, healthData.twoHundredDayAvg)}`
              : "\u2014"}
            signal={twoHundredDmaSignal === "above" ? "green" : twoHundredDmaSignal === "below" ? "red" : "neutral"}
          />
          <IndicatorRow
            label="Revenue Growth"
            value={healthData.revenueGrowth != null ? fmt(healthData.revenueGrowth, 1, "%") : "\u2014"}
            signal={healthData.revenueGrowth != null ? (healthData.revenueGrowth > 0 ? "green" : "red") : "neutral"}
          />
        </CategoryCard>

        {/* Fundamental Quality */}
        <CategoryCard config={CATEGORIES[1]}>
          <IndicatorRow
            label="Earnings Revision (30d)"
            value={revisionText}
            signal={earningsRevSignal}
          />
          {revision90Text && (
            <IndicatorRow
              label="Earnings Revision (90d)"
              value={revision90Text}
              signal={healthData.earningsCurrentEst != null && healthData.earnings90dAgo != null
                ? (healthData.earningsCurrentEst > healthData.earnings90dAgo ? "green" : healthData.earningsCurrentEst < healthData.earnings90dAgo ? "red" : "neutral")
                : "neutral"}
            />
          )}
          <IndicatorRow
            label="FCF Margin"
            value={fmt(healthData.fcfMargin, 1, "%")}
            signal={fcfSignal}
          />
          <IndicatorRow
            label="ROIC"
            value={fmt(healthData.roic, 1, "%")}
            signal={healthData.roic != null ? (healthData.roic > 15 ? "green" : healthData.roic < 5 ? "red" : "neutral") : "neutral"}
          />
        </CategoryCard>

        {/* Valuation vs History */}
        <CategoryCard config={CATEGORIES[2]}>
          <IndicatorRow
            label="Forward P/E"
            value={fmt(healthData.forwardPE, 1, "x")}
            signal="neutral"
          />
          <IndicatorRow
            label="Trailing P/E"
            value={fmt(healthData.trailingPE, 1, "x")}
            signal="neutral"
          />
          <IndicatorRow
            label="PEG Ratio"
            value={fmt(healthData.pegRatio, 2)}
            signal={pegSignal}
          />
          <IndicatorRow
            label="EV/EBITDA"
            value={fmt(healthData.enterpriseToEbitda, 1, "x")}
            signal="neutral"
          />
        </CategoryCard>

        {/* Ownership & Positioning */}
        <CategoryCard config={CATEGORIES[3]}>
          <IndicatorRow
            label="Institutional Ownership"
            value={fmt(healthData.heldPercentInstitutions, 1, "%")}
            signal="neutral"
          />
          <IndicatorRow
            label="Insider Ownership"
            value={fmt(healthData.heldPercentInsiders, 1, "%")}
            signal="neutral"
          />
          <IndicatorRow
            label="Short Interest (% Float)"
            value={fmt(healthData.shortPercentOfFloat, 1, "%")}
            signal={shortSignal}
          />
        </CategoryCard>

        {/* Catalyst Calendar - full width */}
        <CategoryCard config={CATEGORIES[4]}>
          <IndicatorRow
            label="Next Earnings Date"
            value={healthData.earningsDate ?? "\u2014"}
            signal="neutral"
          />
          <IndicatorRow
            label="Ex-Dividend Date"
            value={healthData.exDividendDate ?? "\u2014"}
            signal="neutral"
          />
        </CategoryCard>
      </div>
    </div>
  );
}
