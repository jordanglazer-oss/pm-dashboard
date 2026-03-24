"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { MorningBrief } from "@/app/components/MorningBrief";

export default function BriefPage() {
  const { stocks, scoredStocks, marketData, brief, offensiveExposure, setBrief, updateMarketData } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl space-y-6">
        <MorningBrief
          marketData={marketData}
          offensiveExposure={offensiveExposure}
          brief={brief}
          stocks={stocks}
          scoredStocks={scoredStocks}
          onBriefGenerated={setBrief}
          onUpdateMarketData={updateMarketData}
        />
      </div>
    </main>
  );
}
