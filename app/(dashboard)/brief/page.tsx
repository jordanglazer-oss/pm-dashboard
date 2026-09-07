"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { MorningBrief } from "@/app/components/MorningBrief";
import { DailySummaryView } from "@/app/components/brief/DailySummaryView";

export default function BriefPage() {
  const { stocks, scoredStocks, marketData, brief, offensiveExposure, setBrief, updateMarketData } = useStocks();

  return (
    // Full-width inside the shell's content column; the page body is the
    // 14px stack the workspace uses everywhere. The first row is the brief's
    // own toolbar (date · generated · daily-input meta · actions).
    <main className="flex flex-col gap-3.5 text-ink">
      <MorningBrief
        marketData={marketData}
        offensiveExposure={offensiveExposure}
        brief={brief}
        stocks={stocks}
        scoredStocks={scoredStocks}
        onBriefGenerated={setBrief}
        onUpdateMarketData={updateMarketData}
        variant="summary"
        summary={<DailySummaryView />}
      />
    </main>
  );
}
