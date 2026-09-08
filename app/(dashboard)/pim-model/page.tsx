"use client";

import React, { useEffect, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimModel } from "@/app/components/PimModel";
import { ModelScenarios } from "@/app/components/ModelScenarios";
import { ModelEligibilityMatrix } from "@/app/components/ModelEligibilityMatrix";
import { AppIcon } from "@/app/components/AppIcon";

export default function PimModelPage() {
  const { pimModels } = useStocks();
  // Model Scenarios opens in a full-viewport subwindow so the whole scenario
  // (actions + preview diff) reads at once instead of being scrolled past
  // inline. Esc or the backdrop closes it; the component inside is unchanged.
  const [scenariosOpen, setScenariosOpen] = useState(false);
  useEffect(() => {
    if (!scenariosOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScenariosOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [scenariosOpen]);

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* Page title lives in the top bar. The page's first row is the model
          toolbar, rendered by PimModel — the Scenarios launcher sits in it. */}
      <PimModel groups={pimModels.groups} onOpenScenarios={() => setScenariosOpen(true)} />

      {/* Eligibility matrix — moved here from the individual stock pages. */}
      <ModelEligibilityMatrix />

      {/* Model Scenarios subwindow */}
      {scenariosOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-3 md:p-6"
          onClick={() => setScenariosOpen(false)}
        >
          <div
            className="flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-card border border-line bg-ground shadow-[var(--shadow-pop)]"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Model Scenarios"
          >
            <div className="flex shrink-0 items-center gap-2.5 border-b border-line bg-surface px-3.5 py-2">
              <h2 className="text-[13px] font-semibold text-ink">Model Scenarios</h2>
              <span className="text-[11.5px] text-ink-3">scratchpad — saved to pm:model-scenarios only; the live model is never written</span>
              <button
                onClick={() => setScenariosOpen(false)}
                aria-label="Close"
                className="ml-auto grid h-7 w-7 place-items-center rounded-control border border-line bg-surface text-ink-2 hover:bg-surface-hover"
              >
                <AppIcon name="x" size={14} />
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-3.5">
              <ModelScenarios groups={pimModels.groups} alwaysOpen />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
