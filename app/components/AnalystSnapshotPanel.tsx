"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  TickerSnapshot,
  AnalystEntry,
  AnalystRating,
  FactSetEntry,
  ConsensusBreakdown,
} from "@/app/lib/analyst-snapshots";

type Props = {
  ticker: string;
  currentPrice?: number;
  snapshot: TickerSnapshot | undefined;
  breakdown: ConsensusBreakdown;
  onChange: (next: TickerSnapshot | undefined) => void;
};

const RATING_OPTIONS: { value: AnalystRating; label: string }[] = [
  { value: "outperform", label: "Outperform / Overweight" },
  { value: "neutral", label: "Sector Perform / Neutral / Hold" },
  { value: "underperform", label: "Underperform / Underweight" },
  { value: "not-covered", label: "Not covered" },
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function freshnessChip(label: "fresh" | "stale" | "very-stale") {
  if (label === "fresh") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (label === "stale") return "bg-amber-50 text-amber-700 border-amber-200";
  return "bg-red-50 text-red-700 border-red-200";
}

export function AnalystSnapshotPanel({ ticker, currentPrice, snapshot, breakdown, onChange }: Props) {
  const [local, setLocal] = useState<TickerSnapshot>(() => snapshot ?? {});
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const incoming = snapshot ?? {};
    if (JSON.stringify(local) !== JSON.stringify(incoming)) setLocal(incoming);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleSave = useCallback((next: TickerSnapshot) => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      const hasAny = Boolean(next.rbc || next.jpm || next.factset);
      onChangeRef.current(hasAny ? next : undefined);
      saveTimerRef.current = null;
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        const hasAny = Boolean(local.rbc || local.jpm || local.factset);
        onChangeRef.current(hasAny ? local : undefined);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patchAnalyst = (which: "rbc" | "jpm", patch: Partial<AnalystEntry>) => {
    const existing: AnalystEntry = local[which] ?? { rating: "not-covered" };
    const merged: AnalystEntry = { ...existing, ...patch, lastUpdated: new Date().toISOString() };
    // Auto-fill priceAtReport from current Yahoo price when the user enters
    // a target without one. Override preserved if the user already set it.
    if (patch.target !== undefined && merged.priceAtReport === undefined && currentPrice) {
      merged.priceAtReport = currentPrice;
    }
    if (!merged.asOf && (patch.rating !== undefined || patch.target !== undefined)) {
      merged.asOf = todayIso();
    }
    const next: TickerSnapshot = { ...local, [which]: merged };
    setLocal(next);
    scheduleSave(next);
  };

  const patchFactSet = (patch: Partial<FactSetEntry>) => {
    const existing: FactSetEntry = local.factset ?? {};
    const merged: FactSetEntry = { ...existing, ...patch, lastUpdated: new Date().toISOString() };
    if (!merged.asOf && (patch.averageTarget !== undefined || patch.analystCount !== undefined)) {
      merged.asOf = todayIso();
    }
    const next: TickerSnapshot = { ...local, factset: merged };
    setLocal(next);
    scheduleSave(next);
  };

  const clearAnalyst = (which: "rbc" | "jpm") => {
    const next: TickerSnapshot = { ...local };
    delete next[which];
    setLocal(next);
    scheduleSave(next);
  };

  const clearFactSet = () => {
    const next: TickerSnapshot = { ...local };
    delete next.factset;
    setLocal(next);
    scheduleSave(next);
  };

  const renderAnalyst = (which: "rbc" | "jpm", label: string) => {
    const entry = local[which];
    const contribution = which === "rbc" ? breakdown.rbc : breakdown.jpm;
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-slate-700">{label}</span>
            {contribution && (
              <span
                className={`rounded border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider ${freshnessChip(contribution.freshnessLabel)}`}
                title={contribution.freshnessReason || `Freshness multiplier ${contribution.freshness.toFixed(2)}×`}
              >
                {contribution.freshnessLabel}
              </span>
            )}
            {contribution && (
              <span className="text-[10px] text-slate-500">
                {contribution.contribution.toFixed(2)} pts
              </span>
            )}
          </div>
          {entry && (
            <button
              type="button"
              onClick={() => clearAnalyst(which)}
              className="text-[10px] text-slate-400 hover:text-red-600"
              title={`Clear ${label} entry`}
            >
              Clear
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">Rating</span>
            <select
              value={entry?.rating ?? "not-covered"}
              onChange={(e) => patchAnalyst(which, { rating: e.target.value as AnalystRating })}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            >
              {RATING_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">Target price</span>
            <input
              type="number"
              step="0.01"
              value={entry?.target ?? ""}
              onChange={(e) => patchAnalyst(which, { target: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="$"
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">Report date</span>
            <input
              type="date"
              value={entry?.asOf ?? ""}
              onChange={(e) => patchAnalyst(which, { asOf: e.target.value })}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500" title="Underlying price at the time of the report. Used to detect adverse moves for freshness decay.">
              Price at report
            </span>
            <input
              type="number"
              step="0.01"
              value={entry?.priceAtReport ?? ""}
              onChange={(e) => patchAnalyst(which, { priceAtReport: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder={currentPrice ? `Auto: $${currentPrice.toFixed(2)}` : "$"}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
        </div>
      </div>
    );
  };

  const factset = local.factset;
  return (
    <div className="ml-1 mt-3 mb-1 space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
        Analyst Snapshot · {ticker}
      </p>

      {/* FactSet street consensus */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-slate-700">FactSet street consensus</span>
          {factset && (
            <button
              type="button"
              onClick={clearFactSet}
              className="text-[10px] text-slate-400 hover:text-red-600"
            >
              Clear
            </button>
          )}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">Avg target price</span>
            <input
              type="number"
              step="0.01"
              value={factset?.averageTarget ?? ""}
              onChange={(e) => patchFactSet({ averageTarget: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="$"
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500"># of analysts</span>
            <input
              type="number"
              value={factset?.analystCount ?? ""}
              onChange={(e) => patchFactSet({ analystCount: e.target.value === "" ? undefined : Number(e.target.value) })}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
          <label className="flex flex-col gap-0.5">
            <span className="text-slate-500">As of</span>
            <input
              type="date"
              value={factset?.asOf ?? ""}
              onChange={(e) => patchFactSet({ asOf: e.target.value })}
              className="rounded border border-slate-200 bg-white px-1.5 py-1 outline-none focus:border-blue-400"
            />
          </label>
        </div>
        {breakdown.upside.target && breakdown.upside.upsidePercent !== undefined && (
          <p className="mt-2 text-[10px] text-slate-500">
            Implied upside: {breakdown.upside.upsidePercent >= 0 ? "+" : ""}
            {breakdown.upside.upsidePercent.toFixed(1)}% → contribution {breakdown.upside.contribution.toFixed(2)} pts
            {breakdown.upside.targetSource === "rbc-jpm-average" && (
              <span className="ml-1 italic">(no FactSet target — fell back to RBC/JPM average)</span>
            )}
          </p>
        )}
      </div>

      {renderAnalyst("rbc", "RBC")}
      {renderAnalyst("jpm", "JPM")}

      <p className="text-[10px] text-slate-400 italic">
        Edits save automatically. Score updates on next rescore.
      </p>
    </div>
  );
}
