"use client";

/**
 * Dashboard Market-Regime strip — compact read of the deterministic
 * regime snapshot persisted in `pm:market-regime` by /api/market-regime.
 *
 * Reads only — no writes, no mutation of Redis. If the fetch fails
 * the strip silent-hides so the dashboard still renders cleanly.
 *
 * Shows every signal the composite uses (SPX 10M, RSP/SPY breadth,
 * XLY/XLP, XLK/XLU, MTUM/USMV, VIX level) as an individual pill,
 * matching the Morning Brief's regime strip 1:1. The composite label
 * (Risk-On / Neutral / Risk-Off) sits on the left so you get a
 * one-glance answer before scanning the drivers.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { MarketRegimeData, RegimeDirection } from "@/app/lib/market-regime";

function pillClasses(d: RegimeDirection): string {
  switch (d) {
    case "risk-on":  return "border-emerald-300 bg-emerald-50 text-emerald-700";
    case "risk-off": return "border-red-300 bg-red-50 text-red-700";
    case "neutral":  return "border-amber-300 bg-amber-50 text-amber-700";
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
          {regime.composite.signals.map((s, i) => (
            <span
              key={i}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${pillClasses(s.direction)}`}
              title={s.detail}
            >
              <span className="font-semibold">{s.name}</span>
              <span className="opacity-70">·</span>
              <span className="font-mono opacity-80">{s.detail}</span>
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
