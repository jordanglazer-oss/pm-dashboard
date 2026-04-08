"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimPortfolio } from "@/app/components/PimPortfolio";

export default function PortfolioPage() {
  const { pimModels } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-800">Positioning</h1>
          <p className="text-sm text-slate-500 mt-1">
            Current positions, weights, drift from target, rebalance and trade actions
          </p>
        </div>
        <PimPortfolio groups={pimModels.groups} />
      </div>
    </main>
  );
}
