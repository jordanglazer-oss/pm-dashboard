"use client";

/**
 * Market-regime strip — compact read of the deterministic regime snapshot
 * persisted in `pm:market-regime` by /api/market-regime.
 *
 * Reads only — no writes, no mutation of Redis. If the fetch fails the strip
 * silent-hides so the page still renders cleanly.
 *
 * Shows every signal the composite uses (SPX 10M, RSP/SPY breadth, XLY/XLP,
 * XLK/XLU, MTUM/USMV, VIX level) as dot + word, matching the Brief's regime
 * detail 1:1. The composite label (Risk-On / Neutral / Risk-Off) sits on the
 * left so you get a one-glance answer before scanning the drivers.
 */

import React, { useEffect, useState } from "react";
import Link from "next/link";
import type { MarketRegimeData, RegimeDirection } from "@/app/lib/market-regime";
import { HORIZONS } from "@/app/lib/horizons";
import { AppIcon } from "./AppIcon";

function dotFor(d: RegimeDirection): string {
  switch (d) {
    case "risk-on":  return "bg-pos";
    case "risk-off": return "bg-neg";
    case "neutral":  return "bg-warn";
  }
}

/** The regime label is the subject here, so it keeps its pill. */
function labelPill(label: "Risk-On" | "Neutral" | "Risk-Off"): string {
  if (label === "Risk-On") return "bg-pos-soft text-pos";
  if (label === "Risk-Off") return "bg-neg-soft text-neg";
  return "bg-warn-soft text-warn";
}

const PILL = "inline-flex h-[18px] items-center whitespace-nowrap rounded px-1.5 text-[11px] font-medium";

/**
 * `compact`: ONE line — label, dial, distance to a flip, Open Brief. No
 * per-signal rows and no per-horizon chips: those belong on the Brief's
 * regime breakdown, where the PM asked for them; on the Portfolio home they
 * repeated the whole engine read on a page about holdings.
 */
export function RegimeStrip({ bare = false, compact = false }: { bare?: boolean; compact?: boolean } = {}) {
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

  // Skeleton while loading; vanish entirely on error/no data so the grid
  // doesn't shift layout on retries.
  if (loading) {
    return (
      <div className={`${bare ? "" : "panel p-3.5 "}animate-pulse`}>
        <div className="flex items-center gap-3">
          <div className="h-[18px] w-20 rounded bg-surface-2" />
          <div className="flex gap-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[18px] w-28 rounded bg-surface-2" />
            ))}
          </div>
        </div>
      </div>
    );
  }
  if (!regime) return null;

  if (compact) {
    const c = regime.composite;
    const off = c.signals.filter((s) => s.direction === "risk-off").length;
    const flat = c.total - c.score - off;
    return (
      <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] ${bare ? "" : "panel px-3.5 py-2.5"}`}>
        <span className="text-[11px] text-ink-3">Market regime</span>
        <span className={`${PILL} ${labelPill(c.label)}`}>{c.label}</span>
        {typeof c.score100 === "number" && (
          <span className="font-mono text-ink-2" title="Weighted regime dial, 0 = risk-off … 100 = risk-on">
            dial <span className="font-medium text-ink">{c.score100}</span>
          </span>
        )}
        <span className="font-mono text-[11px] text-ink-3" title={c.signals.map((s) => `${s.name}: ${s.direction}`).join("\n")}>
          {c.score} on · {off} off · {flat} flat / {c.total}
        </span>
        {c.pending ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-warn" title="The raw read has moved; the label follows after three consecutive sessions">
            <span className="dot bg-warn" />
            reads {c.pending.label} {c.pending.days}/{c.pending.needed}
          </span>
        ) : typeof c.signalsToShed === "number" && c.signalsToShed > 0 && c.signalsToShed <= 2 ? (
          <span className="text-[11px] text-ink-3">{c.signalsToShed} signal{c.signalsToShed === 1 ? "" : "s"} from a change</span>
        ) : null}
        <Link href="/brief" className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-accent hover:text-accent-ink" title="The full breakdown — every signal and what it is worth on the dial">
          Why
          <AppIcon name="arrowR" size={12} />
        </Link>
      </div>
    );
  }

  return (
    <div className={bare ? "overflow-hidden" : "panel overflow-hidden px-3.5 py-3"}>
      {/* Top row — label + count, then every signal as dot + word (the detail
          on hover), and the Brief link. */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-ink-3">Market regime</span>
          <span className={`${PILL} ${labelPill(regime.composite.label)}`}>{regime.composite.label}</span>
          <span className="font-mono text-[11px] text-ink-3">
            {regime.composite.score}/{regime.composite.total} risk-on
          </span>
        </div>

        <div className="flex min-w-0 flex-1 flex-wrap gap-x-3 gap-y-1 text-[11.5px]">
          {regime.composite.signals.map((s, i) => (
            <span key={i} className="inline-flex max-w-full items-center gap-1.5 whitespace-nowrap" title={s.detail}>
              <span className={`dot ${dotFor(s.direction)}`} />
              <span className="truncate text-ink-2">{s.name}</span>
              <span className="truncate font-mono text-ink-3">{s.detail}</span>
            </span>
          ))}
        </div>

        <Link
          href="/brief"
          className="inline-flex items-center gap-1 self-start text-[11.5px] text-accent hover:text-accent-ink sm:self-auto sm:whitespace-nowrap"
          title="Open the Morning Brief for the full analysis"
        >
          Open brief
          <AppIcon name="arrowR" size={12} />
        </Link>
      </div>

      {/*
        Horizon row — renders only when the cached blob includes the new
        `horizons` field (older snapshots still render the row above and
        silently skip this sub-row, no layout jank). Each entry shows the
        horizon's label, its label, and the on/off count; hover shows the
        per-horizon signal list.
      */}
      {regime.horizons && (
        <div className="mt-2.5 border-t border-line-soft pt-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px]">
            <span className="text-[11px] text-ink-3">By horizon</span>
            {HORIZONS.map((h) => {
              const b = regime.horizons!.byHorizon[h.id];
              const empty = b.total === 0;
              return (
                <span
                  key={h.id}
                  className="inline-flex max-w-full items-center gap-1.5"
                  title={
                    empty
                      ? `${h.description} · No signals available yet.`
                      : `${h.description}\n\n${b.signals
                          .map((s) => `• ${s.name}: ${s.detail}`)
                          .join("\n")}`
                  }
                >
                  <span className={`dot ${empty ? "bg-ink-faint" : b.label_ === "Risk-On" ? "bg-pos" : b.label_ === "Risk-Off" ? "bg-neg" : "bg-warn"}`} />
                  <span className="text-ink-2">{h.shortLabel}</span>
                  <span className="font-medium text-ink">{empty ? "—" : b.label_}</span>
                  {!empty && (
                    <span className="font-mono text-ink-3">
                      {b.riskOn} on · {b.riskOff} off / {b.total}
                    </span>
                  )}
                  <span className="font-mono text-[10.5px] text-ink-faint">×{Math.round(h.weight * 100)}%</span>
                </span>
              );
            })}
            {isFinite(regime.horizons.weightedScore) && (
              <span className="ml-auto text-[11px] text-ink-3">
                Weighted <span className="font-medium text-ink">{regime.horizons.weightedLabel}</span>{" "}
                <span className="font-mono">
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
