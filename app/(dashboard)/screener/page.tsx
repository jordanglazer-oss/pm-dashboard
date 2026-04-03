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

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <TechnicalScreener stocks={scoredStocks} onAddToWatchlist={handleAddToWatchlist} />
      </div>
    </main>
  );
}
