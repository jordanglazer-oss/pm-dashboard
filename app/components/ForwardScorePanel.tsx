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

/** Regime fit → status dot + word (colour by job). */
const FIT_DOT: Record<string, { dot: string; text: string; word: string }> = {
  favored: { dot: "bg-pos", text: "text-pos", word: "Favored" },
  neutral: { dot: "bg-ink-faint", text: "text-ink-3", word: "Neutral" },
  headwind: { dot: "bg-neg", text: "text-neg", word: "Headwind" },
};

function FitCell({ fit }: { fit?: string }) {
  const f = fit ? FIT_DOT[fit] : undefined;
  if (!f) return <span className="text-ink-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={`dot ${f.dot}`} />
      <span className={`text-[12px] ${f.text}`}>{f.word}</span>
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
          <span className="text-[11px] font-normal text-ink-3">beta</span>
        </span>
      }
      subtitle="Your scores, tilted toward the regime you're heading into"
      right={
        <div className="seg" title="Reveal the forward-tilted view (a lens — never changes live scores)">
          <button type="button" onClick={() => setUiPref("forwardScoreEnabled", "0")} className={enabled ? "" : "on"}>Off</button>
          <button type="button" onClick={() => setUiPref("forwardScoreEnabled", "1")} className={enabled ? "on" : ""}>On</button>
        </div>
      }
    >
      {!enabled ? (
        <p className="text-[12.5px] leading-5 text-ink-2">
          A parallel, forward-looking view of your scores — each holding blended toward the regime you&apos;re leaning into,
          weighted by how likely the shift is. It <span className="font-medium text-ink">never changes</span> your live scores, ratings, or rankings — it&apos;s a lens.
          Turn it <span className="font-medium text-ink">On</span> to see the tilt.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {/* regime context */}
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="font-medium text-ink">{marketData.riskRegime}</span>
            {anticipated && anticipated !== marketData.riskRegime ? (
              <>
                <span className="text-ink-3">leaning</span>
                <span className={`font-medium ${anticipated === "Risk-Off" ? "text-neg" : "text-pos"}`}>{anticipated}</span>
                <span className="text-ink-3">· blend <span className="font-mono text-ink-2">{Math.round(p * 100)}%</span></span>
              </>
            ) : (
              <span className="text-ink-3">· no directional lean right now (calm regime) — forward scores match current</span>
            )}
          </div>

          {/* book-level readiness */}
          {anticipated && anticipated !== marketData.riskRegime && (
            <p className="text-[12.5px] leading-5 text-ink-2">
              <span className="font-mono font-medium text-ink">{headwindCount}</span> of <span className="font-mono">{port.length}</span> holdings face a headwind in the{" "}
              <span className="font-medium text-ink">{anticipated}</span> regime you&apos;re leaning toward
              {diverging.length > 0 ? " — the biggest score shifts are below." : "."}
            </p>
          )}

          {/* per-holding divergence */}
          {diverging.length === 0 ? (
            <p className="text-[12.5px] text-ink-3">
              No meaningful score shifts right now — the current and forward regimes tilt these names the same way.
            </p>
          ) : (
            <div className="-mx-3.5 overflow-x-auto border-t border-line-soft">
              <table className="data-table min-w-[520px]">
                <thead>
                  <tr>
                    <th className="!pl-3.5">Ticker</th>
                    <th className="n">Now</th>
                    <th className="n">Forward</th>
                    <th className="n">Shift</th>
                    <th>Fit now</th>
                    <th>Fit next</th>
                  </tr>
                </thead>
                <tbody>
                  {diverging.slice(0, 12).map(({ s, delta }: { s: ScoredStock; delta: number }) => (
                    <tr key={s.ticker}>
                      <td className="!pl-3.5">
                        <Link href={`/stock/${s.ticker.toLowerCase()}`} className="font-mono font-medium text-ink hover:underline">
                          {s.ticker}
                        </Link>
                      </td>
                      <td className="n"><span className="text-ink-2">{s.adjusted.toFixed(1)}</span></td>
                      <td className="n font-medium">{(s.forwardAdjusted ?? s.adjusted).toFixed(1)}</td>
                      <td className="n"><span className={delta > 0 ? "text-pos" : "text-neg"}>{delta > 0 ? "+" : ""}{delta.toFixed(1)}</span></td>
                      <td><FitCell fit={s.regimeFitNow} /></td>
                      <td><FitCell fit={s.regimeFitNext} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <p className="text-[11.5px] leading-4 text-ink-3">
            Forward score = raw × a blend of the current-regime and anticipated-regime sector tilt (weight from transition risk). A lens on top of your live scores — it never changes ratings or rankings.
          </p>
        </div>
      )}
    </CollapsibleSection>
  );
}
