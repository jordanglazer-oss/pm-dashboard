"use client";

import React, { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { ScoredStock } from "@/app/lib/types";
import { MAX_SCORE } from "@/app/lib/types";
import { SignalPill, ratingTone, riskTone } from "./SignalPill";

type SortKey = "ticker" | "bucket" | "sector" | "raw" | "adjusted" | "rating" | "risk" | "effect";
type SortDir = "asc" | "desc";

type Props = {
  stocks: ScoredStock[];
};

const RATING_ORDER: Record<string, number> = { Buy: 3, Hold: 2, Sell: 1 };
const RISK_ORDER: Record<string, number> = { High: 3, Medium: 2, Low: 1 };

export function StockScoring({ stocks }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("adjusted");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "ticker" || key === "bucket" || key === "sector" ? "asc" : "desc");
    }
  }

  const sorted = useMemo(() => {
    const filtered = stocks.filter((s) =>
      `${s.ticker} ${s.name} ${s.sector} ${s.bucket}`
        .toLowerCase()
        .includes(query.toLowerCase())
    );

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case "ticker": cmp = a.ticker.localeCompare(b.ticker); break;
        case "bucket": cmp = a.bucket.localeCompare(b.bucket); break;
        case "sector": cmp = a.sector.localeCompare(b.sector); break;
        case "raw": cmp = a.raw - b.raw; break;
        case "adjusted": cmp = a.adjusted - b.adjusted; break;
        case "rating": cmp = (RATING_ORDER[a.rating] || 0) - (RATING_ORDER[b.rating] || 0); break;
        case "risk": cmp = (RISK_ORDER[a.risk] || 0) - (RISK_ORDER[b.risk] || 0); break;
        case "effect": cmp = (a.adjusted - a.raw) - (b.adjusted - b.raw); break;
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [stocks, query, sortKey, sortDir]);

  const arrow = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ▲" : " ▼") : "";

  return (
    <section className="rounded-[30px] border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <h3 className="text-2xl font-semibold">Stock Scoring</h3>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search ticker, name, sector, or bucket"
          className="w-full min-w-[260px] rounded-2xl border border-slate-200 bg-white px-4 py-3 outline-none placeholder:text-slate-400 md:w-auto"
        />
      </div>

      <div className="mt-5 overflow-x-auto">
        <table className="w-full min-w-[1300px] text-left">
          <thead>
            <tr className="border-b border-slate-200 text-sm text-slate-500">
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("ticker")}>Ticker{arrow("ticker")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("bucket")}>Bucket{arrow("bucket")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("sector")}>Sector{arrow("sector")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("raw")}>Raw{arrow("raw")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("adjusted")}>Regime adj.{arrow("adjusted")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("rating")}>Rating{arrow("rating")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("risk")}>Risk{arrow("risk")}</th>
              <th className="pb-3 cursor-pointer hover:text-slate-800 select-none" onClick={() => toggleSort("effect")}>Regime effect{arrow("effect")}</th>
              <th className="pb-3">What They Do</th>
              <th className="pb-3">Why Own It</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((s) => {
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
                  <td className="max-w-[280px] py-4 text-xs leading-relaxed text-slate-600">
                    {s.companySummary || <span className="text-slate-300 italic">Score to generate</span>}
                  </td>
                  <td className="max-w-[280px] py-4 text-xs leading-relaxed text-slate-600">
                    {s.investmentThesis || <span className="text-slate-300 italic">Score to generate</span>}
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
