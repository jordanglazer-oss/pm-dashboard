"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimPortfolio } from "@/app/components/PimPortfolio";
import { PortfolioXray } from "@/app/components/PortfolioXray";
import { ThesisWatch } from "@/app/components/ThesisWatch";
import { DecisionJournal } from "@/app/components/DecisionJournal";

export default function PortfolioPage() {
  const { pimModels } = useStocks();

  return (
    <main className="min-h-screen bg-ground px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-ink">Positioning</h1>
          <p className="text-sm text-ink-3 mt-1">
            Current positions, weights, drift from target, rebalance and trade actions
          </p>
        </div>
        <div id="xray" className="scroll-mt-24">
          <PortfolioXray />
        </div>
        <div className="mt-6">
          <ThesisWatch />
        </div>
        <div className="mt-6">
          <DecisionJournal />
        </div>
        <PimPortfolio groups={pimModels.groups} />
      </div>
    </main>
  );
}
