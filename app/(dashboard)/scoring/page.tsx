"use client";

import React, { useCallback } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { StockScoring } from "@/app/components/StockScoring";
import type { ScoreKey, HealthData, Stock } from "@/app/lib/types";
import type { TechnicalIndicators, RiskAlert } from "@/app/lib/technicals";

export default function ScoringPage() {
  const { stocks, scoredStocks, updateScore, updateExplanations, updateLastScored, updatePrice, updateHealthData, updateTechnicals, updateStockFields, updateFundData, updateMarketData } = useStocks();

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
    if (data.companySummary || data.investmentThesis || data.sector || data.name) {
      updateStockFields(ticker, {
        ...(data.companySummary ? { companySummary: data.companySummary } : {}),
        ...(data.investmentThesis ? { investmentThesis: data.investmentThesis } : {}),
        ...(data.sector ? { sector: data.sector } : {}),
        ...(data.name && data.name !== "Unknown" ? { name: data.name } : {}),
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

  const handleRefreshData = useCallback((ticker: string, data: { name?: string; sector?: string; price?: number; beta?: number; technicals?: unknown; healthData?: unknown; riskAlert?: unknown }) => {
    if (data.price != null) {
      updatePrice(ticker, data.price);
    }
    if (data.healthData) {
      updateHealthData(ticker, data.healthData as HealthData);
    }
    if (data.technicals) {
      const fallbackAlert: RiskAlert = { level: "clear", signals: [], summary: "No signals", dangerCount: 0, cautionCount: 0 };
      updateTechnicals(ticker, data.technicals as TechnicalIndicators, (data.riskAlert as RiskAlert) || fallbackAlert);
    }
    // Only persist Yahoo's beta for individual stocks; ETFs/MFs use a
    // different beta source (Morningstar BetaM36 via /api/fund-data).
    const current = stocks.find((s) => s.ticker === ticker);
    const isStock = !current?.instrumentType || current.instrumentType === "stock";
    const fields: Partial<Stock> = {};
    if (data.name) fields.name = data.name;
    if (data.sector) fields.sector = data.sector;
    if (isStock && typeof data.beta === "number") fields.beta = data.beta;
    if (Object.keys(fields).length > 0) {
      updateStockFields(ticker, fields);
    }
  }, [stocks, updatePrice, updateHealthData, updateTechnicals, updateStockFields]);

  return (
    <main className="min-h-screen bg-[#f4f5f7] px-4 py-6 text-slate-900 md:px-8 md:py-8 overflow-x-hidden">
      <div className="mx-auto max-w-7xl">
        <StockScoring stocks={scoredStocks} onScoreStock={handleScoreStock} onUpdateCostBasis={handleUpdateCostBasis} onRefreshData={handleRefreshData} onUpdateFundData={updateFundData} onUpdateMarketData={updateMarketData} />
      </div>
    </main>
  );
}
