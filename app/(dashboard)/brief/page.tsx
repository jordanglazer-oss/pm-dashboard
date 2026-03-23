"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { MorningBrief } from "@/app/components/MorningBrief";

export default function BriefPage() {
  const { stocks, marketData, brief, offensiveExposure, setBrief } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <MorningBrief
          marketData={marketData}
          offensiveExposure={offensiveExposure}
          brief={brief}
          stocks={stocks}
          onBriefGenerated={setBrief}
        />
      </div>
    </main>
  );
}
