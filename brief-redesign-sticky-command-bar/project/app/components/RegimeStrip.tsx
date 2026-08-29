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
    case "risk-on":  return "border-pos-border bg-pos-soft text-pos";
    case "risk-off": return "border-neg-border bg-neg-soft text-neg";
    case "neutral":  return "border-warn-border bg-warn-soft text-warn";
  }
}

function compositeBadge(label: MarketRegimeData["composite"]["label"]): string {
  if (label === "Risk-On") return "bg-pos text-white";
  if (label === "Risk-Off") return "bg-neg text-white";
  return "bg-warn text-white";
}

function horizonChipClasses(label: "Risk-On" | "Neutral" | "Risk-Off"): string {
  if (label === "Risk-On") return "border-pos-border bg-pos-soft text-pos";
  if (label === "Risk-Off") return "border-neg-border bg-neg-soft text-neg";
  return "border-warn-border bg-warn-soft text-warn";
}

export function RegimeStrip({ bare = false }: { bare?: boolean } = {}) {
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
      <div className={`${bare ? "" : "rounded-card border border-line bg-white p-4 shadow-sm "}animate-pulse`}>
        <div className="flex items-center gap-3">
          <div className="h-6 w-24 rounded-full bg-surface-2" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-7 w-32 rounded-full bg-surface-2" />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!regime) return null;

  return (
    <div className={bare ? "overflow-hidden" : "overflow-hidden rounded-card border border-line bg-white p-3 shadow-sm sm:p-4"}>
      {/* Top row — header chips wrap above the signal pills on mobile, sit
          inline on desktop. The "Open Brief" link drops to its own row on
          mobile so it never competes with pills for horizontal space. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">Market Regime</span>
          <span className={`rounded-full px-3 py-1 text-xs font-bold ${compositeBadge(regime.composite.label)}`}>
            {regime.composite.label}
          </span>
          <span className="text-xs text-ink-3">
            {regime.composite.score}/{regime.composite.total} risk-on
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5 sm:gap-2">
          {regime.composite.signals.map((s, i) => (
            <span
              key={i}
              className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] sm:gap-1.5 sm:px-3 sm:py-1 sm:text-xs ${pillClasses(s.direction)}`}
              title={s.detail}
            >
              <span className="truncate font-semibold">{s.name}</span>
              <span className="opacity-70">·</span>
              <span className="truncate font-mono opacity-80">{s.detail}</span>
            </span>
          ))}
        </div>

        <Link
          href="/brief"
          className="self-start text-[11px] font-medium text-accent hover:text-accent sm:self-auto sm:whitespace-nowrap"
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
        <div className="mt-3 border-t border-line-soft pt-3">
          {/* Horizon chips wrap on mobile; weighted score gets its own row
              below them on mobile, sits flush-right inline on desktop. */}
          <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
            <span className="text-[10px] font-bold uppercase tracking-wider text-ink-3">
              By Horizon
            </span>
            {HORIZONS.map((h) => {
              const b = regime.horizons!.byHorizon[h.id];
              const empty = b.total === 0;
              return (
                <span
                  key={h.id}
                  className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] sm:gap-1.5 sm:px-3 sm:py-1 sm:text-xs ${
                    empty
                      ? "border-line bg-surface-2 text-ink-3"
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
                      {b.riskOn}↑ {b.riskOff}↓ <span className="opacity-60">/ {b.total}</span>
                    </span>
                  )}
                  <span className="text-[10px] opacity-50">
                    ×{Math.round(h.weight * 100)}%
                  </span>
                </span>
              );
            })}
          </div>
          {isFinite(regime.horizons.weightedScore) && (
            <div className="mt-2 text-[11px] text-ink-3 sm:text-right">
              Weighted:{" "}
              <span className="font-semibold text-ink">
                {regime.horizons.weightedLabel}
              </span>{" "}
              <span className="font-mono opacity-70">
                ({regime.horizons.weightedScore >= 0 ? "+" : ""}
                {regime.horizons.weightedScore.toFixed(2)})
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default RegimeStrip;
