"use client";

import { useLiveTodayReturn } from "@/app/lib/useLiveTodayReturn";
import { CountUp } from "@/app/components/CountUp";
import type { PimProfileType } from "@/app/lib/pim-types";

/**
 * Compact "today's return per PIM model" strip for the Rankings header.
 * Replaces the mock's Portfolio Value / Holdings / Cash tiles (dropped per PM):
 * shows the live intraday return for each PIM profile — Balanced, Growth,
 * All-Equity, Alpha, Core — reusing the same useLiveTodayReturn hook the
 * Positioning tab uses (group "pim", one call per profile; the hook dedupes the
 * underlying price fetch per key).
 */

const MODELS: { label: string; profile: PimProfileType }[] = [
  { label: "Balanced", profile: "balanced" },
  { label: "Growth", profile: "growth" },
  { label: "All-Equity", profile: "allEquity" },
  { label: "Alpha", profile: "alpha" },
  { label: "Core", profile: "core" },
];

export function ModelReturnsStrip() {
  // Fixed number of hook calls in a stable order (Rules of Hooks).
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
    <section className="rounded-card border border-line bg-surface px-4 py-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-3 shrink-0">
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
    </section>
  );
}
