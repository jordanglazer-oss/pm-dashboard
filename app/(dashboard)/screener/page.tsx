"use client";

import React, { useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { TechnicalScreener } from "@/app/components/TechnicalScreener";
import type { Stock } from "@/app/lib/types";

export default function ScreenerPage() {
  const { scoredStocks, addStock } = useStocks();

  const handleAddToWatchlist = useCallback((stock: Stock) => {
    // Check if already exists
    if (scoredStocks.some((s) => s.ticker === stock.ticker)) return;
    addStock(stock);
  }, [scoredStocks, addStock]);

  return <TechnicalScreener stocks={scoredStocks} onAddToWatchlist={handleAddToWatchlist} />;
}
