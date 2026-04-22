"use client";

/**
 * Dashboard Market-Regime strip — compact 4-pill read of the
 * deterministic regime snapshot persisted in `pm:market-regime`
 * by /api/market-regime.
 *
 * Reads only — no writes, no mutation of Redis. If the fetch fails
 * the strip silent-hides so the dashboard still renders cleanly.
 *
 * The four pills roll the six underlying signals into the four
 * dimensions most analysts actually glance at first:
 *
 *   1. Trend        ← SPX 10-month trend
 *   2. Breadth      ← RSP/SPY ratio (proxy for cap-weighted vs equal-weighted)
 *   3. Sector Lead  ← rollup of XLY/XLP, XLK/XLU, MTUM/USMV (majority wins)
 *   4. Volatility   ← VIX level bucket
 *
 * The composite label (Risk-On / Neutral / Risk-Off) sits on the
 * left so you get a one-glance answer before scanning the pills.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { MarketRegimeData, RegimeDirection } from "@/app/lib/market-regime";

type RollupPill = {
  label: string;
  direction: RegimeDirection | "none";
  detail: string;
};

function rollupSectorLeadership(r: MarketRegimeData): RollupPill {
  const entries = [
    { tag: "XLY/XLP", v: r.sectorRatios.xlyXlp },
    { tag: "XLK/XLU", v: r.sectorRatios.xlkXlu },
    { tag: "MTUM/USMV", v: r.sectorRatios.mtumUsmv },
  ].filter((e) => e.v != null) as { tag: string; v: NonNullable<typeof r.sectorRatios.xlyXlp> }[];

  if (entries.length === 0) {
    return { label: "Sector Leadership", direction: "none", detail: "no data" };
  }
  const on = entries.filter((e) => e.v.direction === "risk-on").length;
  const off = entries.filter((e) => e.v.direction === "risk-off").length;
  let direction: RegimeDirection = "neutral";
  if (on > off && on >= 2) direction = "risk-on";
  else if (off > on && off >= 2) direction = "risk-off";
  const detail = `${on}/${entries.length} offensive ratios above 50D`;
  return { label: "Sector Leadership", direction, detail };
}

function trendPill(r: MarketRegimeData): RollupPill {
  if (!r.spx10m) return { label: "Trend", direction: "none", detail: "no data" };
  const d = r.spx10m.distancePct;
  return {
    label: "Trend",
    direction: r.spx10m.direction,
    detail: `SPX ${d >= 0 ? "+" : ""}${d.toFixed(1)}% vs 10M MA`,
  };
}

function breadthPill(r: MarketRegimeData): RollupPill {
  if (!r.breadth) return { label: "Breadth", direction: "none", detail: "no data" };
  const c = r.breadth.change20dPct;
  return {
    label: "Breadth",
    direction: r.breadth.direction,
    detail: `RSP/SPY 20d ${c >= 0 ? "+" : ""}${c.toFixed(2)}%`,
  };
}

function volPill(r: MarketRegimeData): RollupPill {
  const vix = r.crossAsset.vix;
  if (!vix) return { label: "Volatility", direction: "none", detail: "no data" };
  return {
    label: "Volatility",
    direction: vix.direction,
    detail: `VIX ${vix.price.toFixed(1)}`,
  };
}

function pillClasses(d: RegimeDirection | "none"): string {
  switch (d) {
    case "risk-on":  return "border-emerald-300 bg-emerald-50 text-emerald-700";
    case "risk-off": return "border-red-300 bg-red-50 text-red-700";
    case "neutral":  return "border-amber-300 bg-amber-50 text-amber-700";
    default:         return "border-slate-200 bg-slate-50 text-slate-500";
  }
}

function compositeBadge(label: MarketRegimeData["composite"]["label"]): string {
  if (label === "Risk-On") return "bg-emerald-600 text-white";
  if (label === "Risk-Off") return "bg-red-600 text-white";
  return "bg-amber-500 text-white";
}

export function RegimeStrip() {
  const [regime, setRegime] = useState<MarketRegimeData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/market-regime");
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data?.regime) setRegime(data.regime as MarketRegimeData);
      } catch {
        // Silent — the strip just hides.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Skeleton while loading; vanish entirely on error/no data so the
  // dashboard grid doesn't shift layout on retries.
  if (loading) {
    return (
      <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm animate-pulse">
        <div className="flex items-center gap-3">
          <div className="h-6 w-24 rounded-full bg-slate-100" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-7 w-32 rounded-full bg-slate-100" />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!regime) return null;

  const pills: RollupPill[] = [
    trendPill(regime),
    breadthPill(regime),
    rollupSectorLeadership(regime),
    volPill(regime),
  ];

  return (
    <div className="rounded-[24px] border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Market Regime</span>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${compositeBadge(regime.composite.label)}`}>
            {regime.composite.label}
          </span>
          <span className="text-xs text-slate-400">
            {regime.composite.score}/{regime.composite.total} risk-on
          </span>
        </div>

        <div className="flex flex-wrap gap-2 flex-1 min-w-0">
          {pills.map((p, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${pillClasses(p.direction)}`}
              title={p.detail}
            >
              <span className="font-semibold">{p.label}</span>
              <span className="opacity-70">·</span>
              <span className="font-mono opacity-80">{p.detail}</span>
            </span>
          ))}
        </div>

        <Link
          href="/brief"
          className="text-[11px] font-medium text-blue-600 hover:text-blue-800 whitespace-nowrap"
          title="Open the Morning Brief for the full analysis"
        >
          Open Brief →
        </Link>
      </div>
    </div>
  );
}

export default RegimeStrip;
