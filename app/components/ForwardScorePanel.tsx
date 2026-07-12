"use client";

import React, { useMemo } from "react";
import Link from "next/link";
import { CollapsibleSection } from "@/app/components/CollapsibleSection";
import { useStocks } from "@/app/lib/StockContext";
import { isScoreable } from "@/app/lib/scoring";
import type { ScoredStock } from "@/app/lib/types";

/**
 * Forward Score panel (Phase 05) — a LENS, never a mutation. Shows each
 * holding's current `adjusted` score alongside its forward-tilted score
 * (blended toward the regime we're leaning into) and the divergence. The
 * canonical `adjusted` score, ratings, and rankings are untouched. Off by
 * default; the toggle here reveals it.
 */

const FIT_CHIP: Record<string, string> = {
  favored: "bg-pos-soft text-pos",
  neutral: "bg-surface-2 text-ink-3",
  headwind: "bg-neg-soft text-neg",
};

function fitChip(label: string, fit?: string) {
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${FIT_CHIP[fit ?? "neutral"]}`}>
      {label}: {fit ?? "—"}
    </span>
  );
}

export function ForwardScorePanel() {
  const { scoredStocks, marketData, uiPrefs, setUiPref } = useStocks();
  const enabled = uiPrefs["forwardScoreEnabled"] === "1";

  const port = useMemo(
    () => scoredStocks.filter((s) => s.bucket === "Portfolio" && isScoreable(s) && typeof s.adjusted === "number"),
    [scoredStocks],
  );

  const ctx = port[0];
  const anticipated = ctx?.anticipatedRegime;
  const p = ctx?.transitionWeight ?? 0;

  const rows = useMemo(() => {
    return port
      .map((s) => ({ s, delta: Math.round(((s.forwardAdjusted ?? s.adjusted) - s.adjusted) * 10) / 10 }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  }, [port]);

  const diverging = rows.filter((r) => Math.abs(r.delta) >= 0.1);
  const headwindCount = port.filter((s) => s.regimeFitNext === "headwind").length;

  return (
    <CollapsibleSection
      prefKey="portfolio.forwardScoreCollapsed"
      className="border-line"
      title={
        <span className="inline-flex items-center gap-2">
          Forward regime score
          <span className="rounded-full bg-accent-soft px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-accent">beta</span>
        </span>
      }
      subtitle="Your scores, tilted toward the regime you're heading into"
      right={
        <button
          onClick={() => setUiPref("forwardScoreEnabled", enabled ? "0" : "1")}
          className={`rounded-full px-2.5 py-1 text-[11px] font-semibold transition-colors ${
            enabled ? "bg-ink text-white" : "border border-line text-ink-3 hover:bg-surface-2"
          }`}
        >
          {enabled ? "On" : "Off"}
        </button>
      }
    >
      {!enabled ? (
        <p className="py-1 text-[13px] text-ink-2">
          A parallel, forward-looking view of your scores — each holding blended toward the regime you&apos;re leaning into,
          weighted by how likely the shift is. It <span className="font-semibold text-ink">never changes</span> your live scores, ratings, or rankings — it&apos;s a lens.
          Turn it <span className="font-semibold">On</span> to see the tilt.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* regime context */}
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-semibold text-ink">{marketData.riskRegime}</span>
            {anticipated && anticipated !== marketData.riskRegime ? (
              <>
                <span className="text-ink-faint">→ leaning</span>
                <span className={`font-semibold ${anticipated === "Risk-Off" ? "text-neg" : "text-pos"}`}>{anticipated}</span>
                <span className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-2">blend {Math.round(p * 100)}%</span>
              </>
            ) : (
              <span className="text-ink-3">· no directional lean right now (calm regime) — forward scores match current</span>
            )}
          </div>

          {/* book-level readiness */}
          {anticipated && anticipated !== marketData.riskRegime && (
            <p className="rounded-control bg-surface-2/60 px-3 py-2 text-[12.5px] text-ink-2">
              <span className="font-semibold text-ink">{headwindCount}</span> of {port.length} holdings face a headwind in the{" "}
              <span className="font-semibold">{anticipated}</span> regime you&apos;re leaning toward
              {diverging.length > 0 ? " — the biggest score shifts are below." : "."}
            </p>
          )}

          {/* per-holding divergence */}
          {diverging.length === 0 ? (
            <p className="text-[13px] text-ink-3">
              No meaningful score shifts right now — the current and forward regimes tilt these names the same way.
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              {diverging.slice(0, 12).map(({ s, delta }: { s: ScoredStock; delta: number }) => (
                <div key={s.ticker} className="flex items-center gap-3 rounded-control border border-line-soft px-3 py-2 text-[13px]">
                  <Link href={`/stock/${s.ticker.toLowerCase()}`} className="w-[60px] shrink-0 font-mono font-semibold text-ink hover:underline">
                    {s.ticker}
                  </Link>
                  <span className="font-mono tabular-nums text-ink-2">{s.adjusted.toFixed(1)}</span>
                  <span className="text-ink-faint">→</span>
                  <span className="font-mono font-semibold tabular-nums text-ink">{(s.forwardAdjusted ?? s.adjusted).toFixed(1)}</span>
                  <span className={`font-mono text-[12px] tabular-nums ${delta > 0 ? "text-pos" : "text-neg"}`}>
                    ({delta > 0 ? "+" : ""}{delta.toFixed(1)})
                  </span>
                  <span className="ml-auto flex items-center gap-1.5">
                    {fitChip("now", s.regimeFitNow)}
                    {fitChip("next", s.regimeFitNext)}
                  </span>
                </div>
              ))}
            </div>
          )}

          <p className="text-[10.5px] leading-4 text-ink-faint">
            Forward score = raw × a blend of the current-regime and anticipated-regime sector tilt (weight from transition risk). A lens on top of your live scores — it never changes ratings or rankings.
          </p>
        </div>
      )}
    </CollapsibleSection>
  );
}
