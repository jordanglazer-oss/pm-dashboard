"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { ScoredStock, Stock, MarketData, ScoreResponse, ScoreKey } from "@/app/lib/types";
import { MAX_SCORE } from "@/app/lib/types";
import { SignalPill, ratingTone, riskTone } from "./SignalPill";
import { LoadingSpinner } from "./LoadingSpinner";

const DEFAULT_MANUAL_SCORES: Partial<Record<ScoreKey, number>> = {
  brand: 0,
  externalSources: 0,
  relativeStrength: 0,
  aiRating: 0,
  turnaround: 0,
};

type Props = {
  stocks: ScoredStock[];
  marketData: MarketData;
  onAddStock: (stock: Stock) => void;
};

export function StockScoring({ stocks, marketData, onAddStock }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [newTicker, setNewTicker] = useState("");
  const [newBucket, setNewBucket] = useState<"Portfolio" | "Watchlist">("Watchlist");
  const [scoring, setScoring] = useState(false);
  const [error, setError] = useState("");

  const filtered = stocks.filter((s) =>
    `${s.ticker} ${s.name} ${s.sector} ${s.bucket}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

  async function handleAdd() {
    const ticker = newTicker.trim().toUpperCase();
    if (!ticker) return;

    setScoring(true);
    setError("");

    try {
      const res = await fetch("/api/score", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticker }),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to score stock");
      }

      const data: ScoreResponse = await res.json();

      const scores: Record<string, number> = { ...DEFAULT_MANUAL_SCORES };
      for (const [key, val] of Object.entries(data.scores)) {
        scores[key] = val;
      }

      onAddStock({
        ticker: data.ticker,
        name: data.name,
        bucket: newBucket,
        sector: data.sector,
        beta: data.beta,
        weights: { portfolio: newBucket === "Portfolio" ? 2 : 0 },
        scores: scores as Record<ScoreKey, number>,
        explanations: data.explanations,
        notes: data.notes,
      });

      setNewTicker("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to score stock");
    } finally {
      setScoring(false);
    }
  }

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <h3 className="text-2xl font-semibold">Stock Scoring</h3>
        <div className="flex flex-col gap-3 md:flex-row">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search ticker, name, sector, or bucket"
            className="w-full min-w-[260px] rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400 md:w-auto"
          />
          <div className="flex gap-3">
            <input
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
              placeholder="Add ticker"
              className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400"
              disabled={scoring}
            />
            <select
              value={newBucket}
              onChange={(e) => setNewBucket(e.target.value as "Portfolio" | "Watchlist")}
              className="rounded-2xl border border-slate-200 bg-white px-4 py-3"
              disabled={scoring}
            >
              <option>Portfolio</option>
              <option>Watchlist</option>
            </select>
            <button
              onClick={handleAdd}
              disabled={scoring}
              className="rounded-2xl bg-slate-900 px-4 py-3 text-white disabled:opacity-50"
            >
              {scoring ? "Scoring..." : "Add"}
            </button>
          </div>
        </div>
      </div>

      {scoring && (
        <LoadingSpinner message={`Scoring ${newTicker.trim().toUpperCase()} with Claude...`} />
      )}

      {error && (
        <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
          {error}
        </div>
      )}

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left">
          <thead>
            <tr className="border-b border-slate-200 text-sm text-slate-500">
              <th className="pb-3">Ticker</th>
              <th className="pb-3">Bucket</th>
              <th className="pb-3">Sector</th>
              <th className="pb-3">Raw</th>
              <th className="pb-3">Regime adj.</th>
              <th className="pb-3">Rating</th>
              <th className="pb-3">Risk</th>
              <th className="pb-3">Regime effect</th>
              <th className="pb-3">Notes</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((s) => {
              const effect = (s.adjusted - s.raw).toFixed(1);
              return (
                <tr
                  key={`${s.ticker}-${s.bucket}`}
                  className="border-b border-slate-100 align-top cursor-pointer hover:bg-slate-50/50 transition-colors"
                  onClick={() => router.push(`/stock/${s.ticker.toLowerCase()}`)}
                >
                  <td className="py-4">
                    <div className="font-semibold text-slate-900">
                      {s.ticker}
                    </div>
                    <div className="text-sm text-slate-500">{s.name}</div>
                  </td>
                  <td className="py-4">
                    <SignalPill
                      tone={s.bucket === "Portfolio" ? "blue" : "gray"}
                    >
                      {s.bucket}
                    </SignalPill>
                  </td>
                  <td className="py-4 text-slate-700">{s.sector}</td>
                  <td className="py-4 text-slate-700">{s.raw}/{MAX_SCORE}</td>
                  <td className="py-4 font-medium text-slate-900">
                    {s.adjusted}/{MAX_SCORE}
                  </td>
                  <td className="py-4">
                    <SignalPill tone={ratingTone(s.rating)}>
                      {s.rating}
                    </SignalPill>
                  </td>
                  <td className="py-4">
                    <SignalPill tone={riskTone(s.risk)}>
                      {s.risk}
                    </SignalPill>
                  </td>
                  <td
                    className={`py-4 font-medium ${
                      Number(effect) >= 0
                        ? "text-emerald-600"
                        : "text-red-600"
                    }`}
                  >
                    {Number(effect) >= 0 ? "+" : ""}
                    {effect}
                  </td>
                  <td className="max-w-[360px] py-4 text-slate-600">
                    {s.notes}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
