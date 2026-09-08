"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimPortfolio } from "@/app/components/PimPortfolio";
import { PortfolioXray } from "@/app/components/PortfolioXray";

export default function PortfolioPage() {
  const { pimModels } = useStocks();

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      {/* Page title lives in the top bar. Positioning itself comes FIRST —
          the X-ray is portfolio-level context rather than positioning, so it
          keeps its content and anchor but sits below the positions table. */}
      <PimPortfolio groups={pimModels.groups} />
      <div id="xray" className="scroll-mt-24">
        <PortfolioXray />
      </div>
      {/* Thesis Watch and the Decision Journal live on their own segments
          (/thesis, /journal) — no duplicates here. */}
    </main>
  );
}
