"use client";

/**
 * "Show the math" for the computed growth score (rubric rev 7).
 *
 * Renders the full working the score route attached to the growth explanation:
 * each metric's value, the peer group it was ranked in, its percentile and
 * weight, the blend, the three top-mark tests, the revision adjustment and the
 * model's single adjustment. A reader should be able to reproduce the score by
 * hand from this panel alone. Open state persists (pm:ui-prefs).
 */

import React from "react";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { GROWTH_CUTS, GROWTH_METRIC_LABEL, TOP_MARK_FLOOR_PCT, type GrowthWorking } from "@/app/lib/growth-score";

type Calc = GrowthWorking & { modelScore: number; modelAdjustment: number; clampedFrom?: number };

const pct = (n: number | null | undefined, d = 1) => (n == null ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(d)}%`);
const Test = ({ ok, children }: { ok: boolean; children: React.ReactNode }) => (
  <li className="flex items-baseline gap-2"><span className={`font-mono text-[11px] ${ok ? "text-pos" : "text-ink-3"}`}>{ok ? "PASS" : "fail"}</span><span>{children}</span></li>
);

export function GrowthMath({ calc }: { calc: Calc }) {
  const [open, toggle] = usePersistedOpen("stock.growthMath.open", false);
  return (
    <div className="rounded border border-line bg-surface">
      <button type="button" onClick={toggle} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[12px] font-medium text-ink hover:bg-surface-hover">
        <span>Show the math — how this growth score was calculated</span>
        <span className="font-mono text-[11px] text-ink-3">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-line px-3 py-3 text-[12px] leading-relaxed text-ink-2">
          <p>
            Ranked against <span className="font-medium text-ink">{calc.rankedIn}</span> ({calc.groupSize} companies
            {calc.foldedFrom ? `; the ${calc.foldedFrom} group is too small to rank in, so its sector is used` : ""}). Peer bands calibrated {calc.calibratedAt.slice(0, 10)}.
            The peer universe is the S&amp;P 500 and TSX 60, so a smaller company is being compared with large caps.
          </p>
          {calc.groupNote && <p className="text-ink-3">{calc.groupNote}</p>}

          <div className="overflow-x-auto">
            <table className="w-full text-[12px]">
              <thead><tr className="border-b border-line text-left text-[10.5px] uppercase tracking-wide text-ink-3">
                <th className="py-1 pr-2">Metric</th><th className="px-2 text-right">This company</th><th className="px-2 text-right">Group median</th><th className="px-2 text-right">Percentile in group</th><th className="px-2 text-right">Weight</th><th className="pl-2 text-right">Contribution</th>
              </tr></thead>
              <tbody>
                {calc.components.map((c) => (
                  <tr key={c.metric} className="border-b border-line">
                    <td className="py-1 pr-2 text-ink">{GROWTH_METRIC_LABEL[c.metric]}</td>
                    <td className="px-2 text-right tabular-nums">{pct(c.value)}</td>
                    <td className="px-2 text-right tabular-nums">{pct(c.groupMedian)}</td>
                    <td className="px-2 text-right tabular-nums">{c.percentile.toFixed(0)}</td>
                    <td className="px-2 text-right tabular-nums">{(c.weight * 100).toFixed(0)}%</td>
                    <td className="pl-2 text-right tabular-nums">{(c.percentile * c.weight).toFixed(1)}</td>
                  </tr>
                ))}
                {calc.excluded.map((e, i) => (
                  <tr key={`x${i}`} className="border-b border-line text-ink-3">
                    <td className="py-1 pr-2">{GROWTH_METRIC_LABEL[e.metric]}</td>
                    <td className="px-2" colSpan={5}>not used — {e.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {calc.computedScore == null ? (
            <p className="text-warn">Fewer than two usable metrics, so no score could be computed. Growth is parked as a data gap and left out of the composite.</p>
          ) : (
            <>
              <p>
                <span className="font-medium text-ink">Blended percentile: {calc.blendedPercentile}</span> (the contributions above, added up). Below {GROWTH_CUTS.one} scores 0, below {GROWTH_CUTS.two} scores 1, below {GROWTH_CUTS.three} scores 2.
                At {GROWTH_CUTS.three} or above, a 3 also has to pass all three tests below; otherwise it stays a 2. Negative forward growth scores 0 outright.
              </p>
              <ul className="flex flex-col gap-0.5">
                <Test ok={calc.topMark!.inTopBand}>Blended percentile of {GROWTH_CUTS.three} or higher (top ~15% of the group)</Test>
                <Test ok={calc.topMark!.noMetricBelowMedian}>No single metric below the group median</Test>
                <Test ok={calc.topMark!.clearsFloor}>Forward growth of at least {TOP_MARK_FLOOR_PCT}% (this company: {pct(calc.topMark!.primaryForwardGrowth)})</Test>
              </ul>
              <div className="overflow-x-auto">
                <table className="text-[12px]">
                  <tbody>
                    <tr><td className="py-0.5 pr-4">Base score from the blend</td><td className="text-right tabular-nums text-ink">{calc.baseScore}</td></tr>
                    <tr><td className="py-0.5 pr-4">Estimate revisions: next-year consensus moved {pct(calc.revision.pct)} in 3 months (more than ±3% moves the score one point)</td><td className="text-right tabular-nums text-ink">{calc.revision.adjustment > 0 ? "+1" : calc.revision.adjustment < 0 ? "−1" : "0"}</td></tr>
                    <tr className="border-t border-line"><td className="py-0.5 pr-4 font-medium text-ink">Computed score</td><td className="text-right tabular-nums font-medium text-ink">{calc.computedScore}</td></tr>
                    <tr><td className="py-0.5 pr-4">Model&apos;s adjustment (at most one point, reason stated in the summary above)</td><td className="text-right tabular-nums text-ink">{calc.modelAdjustment > 0 ? "+1" : calc.modelAdjustment < 0 ? "−1" : "0"}</td></tr>
                    <tr className="border-t border-line"><td className="py-0.5 pr-4 font-medium text-ink">Final growth score</td><td className="text-right tabular-nums font-medium text-ink">{calc.modelScore} / 3</td></tr>
                  </tbody>
                </table>
              </div>
              {calc.clampedFrom != null && <p className="text-warn">The model returned {calc.clampedFrom}, more than one point from the computed score, so the app held it to {calc.modelScore}.</p>}
            </>
          )}
          <p className="text-ink-3">The full method, and every peer group&apos;s cut points, are on the <a href="/methodology#growth-score" className="text-accent hover:underline">Methodology page</a>.</p>
        </div>
      )}
    </div>
  );
}
