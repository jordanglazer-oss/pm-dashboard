"use client";

import React from "react";
import { useStocks } from "@/app/lib/StockContext";
import { PimModel } from "@/app/components/PimModel";

export default function PimModelPage() {
  const { pimModels } = useStocks();

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-800">PIM Model</h1>
          <p className="text-sm text-slate-500 mt-1">
            Portfolio Investment Model — asset allocation and holdings across model groups
          </p>
        </div>
        <PimModel groups={pimModels.groups} />
      </div>
    </main>
  );
}
