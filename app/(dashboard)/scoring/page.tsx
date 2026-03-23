"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { StockScoring } from "@/app/components/StockScoring";

export default function ScoringPage() {
  const { scoredStocks, marketData, addStock } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <StockScoring
          stocks={scoredStocks}
          marketData={marketData}
          onAddStock={addStock}
        />
      </div>
    </main>
  );
}
