"use client";

import { useLiveTodayReturn } from "@/app/lib/useLiveTodayReturn";
import { CountUp } from "@/app/components/CountUp";
import { RegimeStrip } from "@/app/components/RegimeStrip";
import type { PimProfileType } from "@/app/lib/pim-types";

/**
 * Cockpit summary band (#11) — merges the "PIM models · today" strip and the
 * Market-Regime strip into ONE card so the top of the dashboard reads at a
 * glance: model returns for the day on top, the full regime read below. This is
 * a UNION, not a simplification — every regime signal / horizon chip is kept
 * (RegimeStrip renders bare inside this card). Per-model performance detail
 * still lives on the Models sub-tab (PimPerformance). Scales in on mount.
 */

const MODELS: { label: string; profile: PimProfileType }[] = [
  { label: "Balanced", profile: "balanced" },
  { label: "Growth", profile: "growth" },
  { label: "All-Equity", profile: "allEquity" },
  { label: "Alpha", profile: "alpha" },
  { label: "Core", profile: "core" },
];

export function CockpitBand({
  posture,
  consolidatedRegime,
  onApplyPosture,
}: {
  /** The scoring posture that drives multiplier math (marketData.riskRegime). */
  posture?: string;
  /** The canonical regime-engine label, when loaded. */
  consolidatedRegime?: string | null;
  /** Sets the posture to the engine's suggestion. */
  onApplyPosture?: () => void;
} = {}) {
  // Fixed number of hook calls in a stable order (Rules of Hooks) — same as the
  // old ModelReturnsStrip; the hook dedupes the underlying price fetch per key.
  const balanced = useLiveTodayReturn("pim", "balanced");
  const growth = useLiveTodayReturn("pim", "growth");
  const allEquity = useLiveTodayReturn("pim", "allEquity");
  const alpha = useLiveTodayReturn("pim", "alpha");
  const core = useLiveTodayReturn("pim", "core");
  const byProfile: Partial<Record<PimProfileType, number | null>> = {
    balanced: balanced.value,
    growth: growth.value,
    allEquity: allEquity.value,
    alpha: alpha.value,
    core: core.value,
  };

  return (
    <section className="panel">
      {/* Row 1 — model returns today */}
      <div className="border-b border-line-soft px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="shrink-0 text-[11px] text-ink-3">
            PIM models · today
          </span>
          {MODELS.map((m) => {
            const v = byProfile[m.profile] ?? null;
            const cls = v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg";
            return (
              <div key={m.profile} className="flex items-baseline gap-1.5">
                <span className="text-[12.5px] text-ink-2">{m.label}</span>
                {v == null ? (
                  <span className="font-mono text-[13px] font-medium text-ink-3">—</span>
                ) : (
                  <CountUp
                    value={v}
                    format={(n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`}
                    className={`font-mono text-[13px] font-medium ${cls}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 2 — the regime in one line, with the scoring posture beside it.
          The full read (every signal, the horizons) lives on the Brief; here
          it was repeating the whole engine on a page about holdings. */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-3.5 py-2">
        <div className="min-w-0 flex-1">
          <RegimeStrip bare compact />
        </div>
        {posture && (
          <div className="flex flex-wrap items-center gap-2 border-l border-line-soft pl-4 text-[12px]">
            <span className="text-[11px] text-ink-3">Scoring posture</span>
            <span className="inline-flex items-center gap-1.5 font-medium text-ink">
              <span className={`dot ${posture === "Risk-Off" ? "bg-neg" : posture === "Neutral" ? "bg-warn" : "bg-pos"}`} />{posture}
            </span>
            {consolidatedRegime && consolidatedRegime !== posture ? (
              <button
                onClick={onApplyPosture}
                className="inline-flex h-6 items-center rounded-control border border-accent-border bg-accent-soft px-2 text-[11.5px] font-medium text-accent-ink hover:bg-accent hover:text-white transition-colors"
                title={`Set the scoring posture to ${consolidatedRegime} to match the regime engine. This changes the multipliers applied to every stock score.`}
              >
                Engine suggests {consolidatedRegime} — Apply
              </button>
            ) : (
              consolidatedRegime && <span className="text-[11px] text-ink-3">in sync</span>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export default CockpitBand;
