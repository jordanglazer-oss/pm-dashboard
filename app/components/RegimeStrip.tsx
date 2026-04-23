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
import { HORIZONS } from "@/app/lib/horizons";

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

function horizonChipClasses(label: "Risk-On" | "Neutral" | "Risk-Off"): string {
  if (label === "Risk-On") return "border-emerald-400 bg-emerald-50 text-emerald-800";
  if (label === "Risk-Off") return "border-red-400 bg-red-50 text-red-800";
  return "border-amber-400 bg-amber-50 text-amber-800";
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

      {/*
        Horizon chips — renders only when the cached blob includes the new
        `horizons` field (older snapshots still render the row above and
        silently skip this sub-row, no layout jank). Each chip shows the
        horizon's label, a colored composite tag, and the on/off count;
        hover shows the per-horizon signal list.
      */}
      {regime.horizons && (
        <div className="mt-3 border-t border-slate-100 pt-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500">
              By Horizon
            </span>
            {HORIZONS.map((h) => {
              const b = regime.horizons!.byHorizon[h.id];
              const empty = b.total === 0;
              return (
                <span
                  key={h.id}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs ${
                    empty
                      ? "border-slate-200 bg-slate-50 text-slate-400"
                      : horizonChipClasses(b.label_)
                  }`}
                  title={
                    empty
                      ? `${h.description} · No signals available yet.`
                      : `${h.description}\n\n${b.signals
                          .map((s) => `• ${s.name}: ${s.detail}`)
                          .join("\n")}`
                  }
                >
                  <span className="font-semibold">{h.shortLabel}</span>
                  <span className="opacity-70">·</span>
                  <span className="font-bold">{empty ? "—" : b.label_}</span>
                  {!empty && (
                    <span className="font-mono opacity-70">
                      {b.riskOn}-{b.riskOff}/{b.total}
                    </span>
                  )}
                  <span className="opacity-50 text-[10px]">
                    ×{Math.round(h.weight * 100)}%
                  </span>
                </span>
              );
            })}
            {isFinite(regime.horizons.weightedScore) && (
              <span className="ml-auto text-[11px] text-slate-500">
                Weighted:{" "}
                <span className="font-semibold text-slate-700">
                  {regime.horizons.weightedLabel}
                </span>{" "}
                <span className="font-mono opacity-70">
                  ({regime.horizons.weightedScore >= 0 ? "+" : ""}
                  {regime.horizons.weightedScore.toFixed(2)})
                </span>
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default RegimeStrip;
