"use client";

import React, { useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { TechnicalScreener } from "@/app/components/TechnicalScreener";
import type { Stock } from "@/app/lib/types";
import { PageHeading } from "@/app/components/PageHeading";

export default function ScreenerPage() {
  const { scoredStocks, addStock } = useStocks();

  const handleAddToWatchlist = useCallback((stock: Stock) => {
    // Check if already exists
    if (scoredStocks.some((s) => s.ticker === stock.ticker)) return;
    addStock(stock);
  }, [scoredStocks, addStock]);

  return (
    <main className="flex flex-col gap-3.5 text-ink">
      <PageHeading title="Screener" lede="Scored names filtered by their technical setup, to find the ones worth a closer look now." />
      <TechnicalScreener stocks={scoredStocks} onAddToWatchlist={handleAddToWatchlist} />
    </main>
  );
}
