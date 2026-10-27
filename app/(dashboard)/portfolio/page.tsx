"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimPortfolio } from "@/app/components/PimPortfolio";
import { PortfolioXray } from "@/app/components/PortfolioXray";
import { PageHeading } from "@/app/components/PageHeading";

export default function PortfolioPage() {
  const { pimModels } = useStocks();

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      <PageHeading lede="Each book's live weights against its model, what has drifted, and the trades a rebalance would make." />
      {/* Positioning itself comes FIRST —
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
