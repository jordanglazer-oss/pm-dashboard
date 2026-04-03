"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { TechnicalScreener } from "@/app/components/TechnicalScreener";

export default function ScreenerPage() {
  const { scoredStocks } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <TechnicalScreener stocks={scoredStocks} />
      </div>
    </main>
  );
}
