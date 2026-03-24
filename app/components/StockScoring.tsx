"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import type { ScoredStock } from "@/app/lib/types";
import { MAX_SCORE } from "@/app/lib/types";
import { SignalPill, ratingTone, riskTone } from "./SignalPill";

type Props = {
  stocks: ScoredStock[];
};

export function StockScoring({ stocks }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const filtered = stocks.filter((s) =>
    `${s.ticker} ${s.name} ${s.sector} ${s.bucket}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );

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
