"use client";

/**
 * Redesign › performance table: the client models and the benchmark indices
 * over a period the reader picks (presets or a custom start date).
 *
 * READ-ONLY. Model history = pm:pim-performance (recorded daily closes);
 * index history = the existing benchmark history hook. Returns are measured
 * close to close on the recorded series — nothing is estimated here.
 */

import React, { useMemo, useState } from "react";
import type { PimPerformanceData, PimProfileType } from "@/app/lib/pim-types";
import { normalizeSeries, periodReturns, returnSince, type ValuePoint } from "@/app/lib/daily-summary/periods";
import { useBenchmarkHistory, type BenchKey } from "@/app/lib/useBenchmarkHistory";
import { usePerformance } from "./data";
import { AsOf, Empty, fmtSigned, Loading, More, Table, TD, TDN, tone } from "./ui";

type Preset = "1d" | "1w" | "1m" | "3m" | "ytd";
const PRESETS: { id: Preset; label: string }[] = [
  { id: "1d", label: "1 day" },
  { id: "1w", label: "1 week" },
  { id: "1m", label: "1 month" },
  { id: "3m", label: "3 months" },
  { id: "ytd", label: "Year to date" },
];

const MODELS: { profile: PimProfileType; label: string }[] = [
  { profile: "conservative", label: "Conservative" },
  { profile: "balanced", label: "Balanced" },
  { profile: "growth", label: "Growth" },
  { profile: "allEquity", label: "All-Equity" },
];
const SLEEVES: { profile: PimProfileType; label: string }[] = [
  { profile: "core", label: "Core (index ETFs)" },
  { profile: "thematic", label: "Managed Alpha (funds)" },
  { profile: "stocks", label: "Individual stocks" },
  { profile: "alpha", label: "Total Alpha (funds + stocks)" },
];
const INDICES: { key: BenchKey; label: string }[] = [
  { key: "sp500", label: "S&P 500 (US$)" },
  { key: "sp500cad", label: "S&P 500 (C$)" },
  { key: "tsx", label: "S&P/TSX" },
  { key: "nasdaq", label: "Nasdaq (US$)" },
];

function seriesOf(perf: PimPerformanceData | null, profile: PimProfileType): ValuePoint[] {
  const m = perf?.models.find((x) => x.groupId === "pim" && x.profile === profile);
  return m ? normalizeSeries(m.history ?? []) : [];
}

type Row = { label: string; series: ValuePoint[]; index?: boolean };

function ret(series: ValuePoint[], preset: Preset, from: string): number | null {
  if (series.length < 2) return null;
  if (from) return returnSince(series, from);
  return periodReturns(series)[preset];
}

export function PerfTable({ prefKey, compact = false }: { prefKey: string; compact?: boolean }) {
  const { data: perf, loading } = usePerformance();
  const bench = useBenchmarkHistory();
  const [preset, setPreset] = useState<Preset>("ytd");
  const [from, setFrom] = useState("");

  const { main, extra, asOf } = useMemo(() => {
    const idx = (k: BenchKey): ValuePoint[] => normalizeSeries(bench?.[k] ?? []);
    const main: Row[] = [
      ...MODELS.map((m) => ({ label: m.label, series: seriesOf(perf, m.profile) })),
      { label: "S&P 500 (C$)", series: idx("sp500cad"), index: true },
      { label: "S&P/TSX", series: idx("tsx"), index: true },
    ];
    const extra: Row[] = [
      ...SLEEVES.map((m) => ({ label: m.label, series: seriesOf(perf, m.profile) })),
      ...INDICES.filter((i) => i.key !== "sp500cad" && i.key !== "tsx").map((i) => ({ label: i.label, series: idx(i.key), index: true })),
    ];
    const last = seriesOf(perf, "allEquity");
    return { main, extra, asOf: last.length ? last[last.length - 1].date : null };
  }, [perf, bench]);

  if (loading && !perf) return <div className="px-5"><Loading what="Loading performance" /></div>;
  if (!perf) return <div className="px-5"><Empty>Performance is not available right now.</Empty></div>;

  const colLabel = from ? `Since ${from}` : PRESETS.find((p) => p.id === preset)!.label;
  const body = (rows: Row[]) =>
    rows.map((r) => {
      const v = ret(r.series, preset, from);
      const last = r.series.length ? r.series[r.series.length - 1].date : null;
      return (
        <tr key={r.label}>
          <td className={`${TD} ${r.index ? "text-ink-2" : "font-semibold"}`}>
            {r.label}
            {r.index && <span className="ml-2 text-[12.5px] font-normal text-ink-3">index</span>}
          </td>
          <td className={`${TDN} text-[18px] font-semibold ${tone(v)}`}>{fmtSigned(v, 2)}</td>
          {!compact && <td className={`${TD} whitespace-nowrap`}><AsOf at={last} source={r.index ? "Yahoo Finance" : "recorded daily value"} /></td>}
        </tr>
      );
    });
  const head = [{ label: "" }, { label: colLabel, right: true }, ...(compact ? [] : [{ label: "As of · source" }])];

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 px-5 py-3">
        {PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => { setPreset(p.id); setFrom(""); }}
            className={`h-9 rounded-control border px-3 text-[14px] font-medium ${!from && preset === p.id ? "border-accent bg-accent text-white" : "border-line bg-surface text-ink-2 hover:bg-surface-hover"}`}
          >
            {p.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-[13.5px] text-ink-3">
          Since
          <input type="date" value={from} max={asOf ?? undefined} onChange={(e) => setFrom(e.target.value)} className="h-9 rounded-control border border-line bg-surface px-2 text-[14px] text-ink" />
        </label>
      </div>
      <Table head={head} minWidth={compact ? 300 : 520}>{body(main)}</Table>
      <More prefKey={prefKey} label="sleeves and other indices" count={extra.length}>
        <div className="-mx-5"><Table head={head} minWidth={compact ? 300 : 520}>{body(extra)}</Table></div>
      </More>
    </div>
  );
}
