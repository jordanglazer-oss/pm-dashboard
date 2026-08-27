"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimModel } from "@/app/components/PimModel";
import { ModelScenarios } from "@/app/components/ModelScenarios";
import { ModelEligibilityMatrix } from "@/app/components/ModelEligibilityMatrix";

export default function PimModelPage() {
  const { pimModels } = useStocks();

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        {/* Page title lives in the Portfolio hub band above. */}
        <PimModel groups={pimModels.groups} />
        <ModelScenarios groups={pimModels.groups} />
        {/* Eligibility matrix — moved here from the individual stock pages. */}
        <div className="mt-6">
          <ModelEligibilityMatrix />
        </div>
      </div>
    </main>
  );
}
