"use client";

import React, { useEffect, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimModel } from "@/app/components/PimModel";
import { ModelScenarios } from "@/app/components/ModelScenarios";
import { ModelEligibilityMatrix } from "@/app/components/ModelEligibilityMatrix";

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
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        {/* Page title lives in the Portfolio hub band above. */}
        <PimModel groups={pimModels.groups} />

        {/* Scenario scratchpad + eligibility matrix launchers/sections. */}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            onClick={() => setScenariosOpen(true)}
            className="flex items-center gap-2 rounded-control border border-line bg-white px-4 py-2 text-sm font-semibold text-ink-2 shadow-sm hover:bg-surface-hover hover:text-ink transition-colors"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" d="M3.75 3.75v4.5m0-4.5h4.5m-4.5 0L9 9M3.75 20.25v-4.5m0 4.5h4.5m-4.5 0L9 15M20.25 3.75h-4.5m4.5 0v4.5m0-4.5L15 9m5.25 11.25h-4.5m4.5 0v-4.5m0 4.5L15 15" /></svg>
            Model Scenarios…
            <span className="text-[11px] font-normal text-ink-3">opens a subwindow — previews changes, never writes the live model</span>
          </button>
        </div>

        {/* Eligibility matrix — moved here from the individual stock pages. */}
        <div className="mt-6">
          <ModelEligibilityMatrix />
        </div>
      </div>

      {/* Model Scenarios subwindow */}
      {scenariosOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-3 md:p-6"
          onClick={() => setScenariosOpen(false)}
        >
          <div
            className="flex h-[94vh] w-full max-w-[1500px] flex-col overflow-hidden rounded-card border border-line bg-ground shadow-card"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-label="Model Scenarios"
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-line bg-white px-5 py-3">
              <h2 className="text-[15px] font-bold text-ink">Model Scenarios</h2>
              <span className="text-[11px] text-ink-3">scratchpad — saved to pm:model-scenarios only; the live model is never written</span>
              <button
                onClick={() => setScenariosOpen(false)}
                aria-label="Close"
                className="ml-auto flex h-8 w-8 items-center justify-center rounded-control border border-line bg-white text-ink-3 hover:bg-surface-hover hover:text-ink transition-colors"
              >
                ✕
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <ModelScenarios groups={pimModels.groups} />
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
