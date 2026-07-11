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

export function CockpitBand() {
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
    <section className="animate-scale-in overflow-hidden rounded-card border border-line bg-white shadow-card">
      {/* Row 1 — model returns today */}
      <div className="border-b border-line-soft px-4 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <span className="shrink-0 text-[11px] font-semibold uppercase tracking-wide text-ink-3">
            PIM models · today
          </span>
          {MODELS.map((m) => {
            const v = byProfile[m.profile] ?? null;
            const cls = v == null ? "text-ink-3" : v >= 0 ? "text-pos" : "text-neg";
            return (
              <div key={m.profile} className="flex items-baseline gap-1.5">
                <span className="text-[13px] text-ink-2">{m.label}</span>
                {v == null ? (
                  <span className="font-mono text-[14px] font-semibold text-ink-3">—</span>
                ) : (
                  <CountUp
                    value={v}
                    format={(n) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`}
                    className={`font-mono text-[14px] font-semibold ${cls}`}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Row 2 — full market-regime read (bare: no inner card chrome) */}
      <div className="px-3 py-3 sm:px-4">
        <RegimeStrip bare />
      </div>
    </section>
  );
}

export default CockpitBand;
