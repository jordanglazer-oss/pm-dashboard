"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { MorningBrief } from "@/app/components/MorningBrief";
import { DailySummaryView } from "@/app/components/brief/DailySummaryView";
import { TooltipLayer } from "@/app/components/ui/TooltipLayer";

export default function BriefPage() {
  const { stocks, scoredStocks, marketData, brief, offensiveExposure, setBrief, updateMarketData } = useStocks();

  return (
    // Full-width inside the shell's content column; the page body is the
    // 14px stack the workspace uses everywhere. The first row is the brief's
    // own toolbar (date · generated · daily-input meta · actions).
    <main className="text-ink">
      <TooltipLayer className="flex flex-col gap-3.5">
      <MorningBrief
        marketData={marketData}
        offensiveExposure={offensiveExposure}
        brief={brief}
        stocks={stocks}
        scoredStocks={scoredStocks}
        onBriefGenerated={setBrief}
        onUpdateMarketData={updateMarketData}
        variant="summary"
        summary={<DailySummaryView refreshKey={brief?.generatedAt} />}
      />
      </TooltipLayer>
    </main>
  );
}
