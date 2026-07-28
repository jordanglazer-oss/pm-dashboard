"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { MorningBrief } from "@/app/components/MorningBrief";

export default function BriefPage() {
  const { stocks, scoredStocks, marketData, brief, offensiveExposure, setBrief, updateMarketData } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-ink md:px-8 md:py-8 overflow-x-hidden">
      {/* Wider than the rest of the app (which is max-w-7xl / 1280px) — the
          redesign specifies 1560px because the macro board carries 24 metric
          tiles that wrap badly at 1280. Capped, centered, and still fully
          responsive: every grid inside collapses at sm/lg breakpoints. */}
      <div className="mx-auto max-w-[1560px] space-y-6">
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
