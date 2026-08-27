"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimPortfolio } from "@/app/components/PimPortfolio";
import { PortfolioXray } from "@/app/components/PortfolioXray";

export default function PortfolioPage() {
  const { pimModels } = useStocks();

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        {/* Page title lives in the Portfolio hub band above. */}
        {/* Positioning itself comes FIRST. The X-ray, thesis watch and journal
            are all portfolio-level context rather than positioning, and stacked
            above the model they pushed the actual weights and the positions
            table off the first screen — which is the one thing this page exists
            to show. They keep their content and their anchors; they just sit
            below the model now. */}
        <PimPortfolio groups={pimModels.groups} />
        <div id="xray" className="mt-6 scroll-mt-24">
          <PortfolioXray />
        </div>
        {/* Thesis Watch and the Decision Journal live on their own segments
            (/thesis, /journal) — no duplicates here. */}
      </div>
    </main>
  );
}
