"use client";

import React, { useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { StockScoring } from "@/app/components/StockScoring";
import type { ScoreKey } from "@/app/lib/types";

export default function ScoringPage() {
  const { scoredStocks, updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields } = useStocks();

  const handleScoreStock = useCallback(async (ticker: string) => {
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticker }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to score ${ticker}`);
    }
    const data = await res.json();
    if (data.scores) {
      for (const [key, val] of Object.entries(data.scores)) {
        updateScore(ticker, key as ScoreKey, val as number);
      }
    }
    if (data.explanations) {
      updateExplanations(ticker, data.explanations);
    }
    if (data.price != null) {
      updatePrice(ticker, data.price);
    }
    if (data.healthData) {
      updateHealthData(ticker, data.healthData);
    }
    if (data.technicals && data.riskAlert) {
      updateTechnicals(ticker, data.technicals, data.riskAlert);
    }
    if (data.companySummary || data.investmentThesis) {
      updateStockFields(ticker, {
        companySummary: data.companySummary || "",
        investmentThesis: data.investmentThesis || "",
      });
    }
    updateLastScored(ticker, new Date().toLocaleString("en-US", {
      month: "short", day: "numeric", year: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    }));
  }, [updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields]);

  const handleUpdateCostBasis = useCallback((ticker: string, costBasis: number) => {
    updateStockFields(ticker, { costBasis: costBasis || undefined });
  }, [updateStockFields]);

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <StockScoring stocks={scoredStocks} onScoreStock={handleScoreStock} onUpdateCostBasis={handleUpdateCostBasis} />
      </div>
    </main>
  );
}
