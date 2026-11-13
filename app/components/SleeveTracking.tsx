"use client";

import React, { useEffect, useMemo, useState } from "react";
import { Sparkline } from "@/app/components/Sparkline";
import type { PimPerformanceData, PimDailyReturn } from "@/app/lib/pim-types";

/**
 * Sleeves vs Core — the Core, Thematic and Alpha books' performance from the
 * ONE performance engine (pm:pim-performance, fed by the Positioning books'
 * units each day), over any period (preset or custom range). Read-only.
 *
 * Nov 2026: replaced the separate weights-only tracker (pm:sleeve-performance,
 * no longer updated) so there is a single source of truth. A book with no
 * units yet runs on its model weights until units are added on Positioning.
 */

type Preset = "mtd" | "qtd" | "ytd" | "1y" | "all" | "custom";
const PRESETS: { key: Preset; label: string }[] = [
  { key: "mtd", label: "MTD" },
  { key: "qtd", label: "QTD" },
  { key: "ytd", label: "YTD" },
  { key: "1y", label: "1 year" },
  { key: "all", label: "Since start" },
  { key: "custom", label: "Custom" },
];

const BOOKS: { profile: string; label: string; note: string }[] = [
  { profile: "core", label: "Core", note: "S&P 500 and Nasdaq index ETFs" },
  { profile: "thematic", label: "Thematic funds", note: "the Thematic funds alone" },
  { profile: "alpha", label: "Alpha", note: "everything outside Core: stocks + Thematic funds" },
  { profile: "stocks", label: "Stocks", note: "the individual stocks alone" },
];

const iso = (d: Date) => d.toISOString().slice(0, 10);

function rangeFor(p: Preset, custom: { from: string; to: string }): { from: string | null; to: string } {
  const now = new Date();
  const today = iso(now);
  if (p === "custom") return { from: custom.from || null, to: custom.to || today };
  if (p === "all") return { from: null, to: today };
  if (p === "mtd") return { from: `${today.slice(0, 7)}-01`, to: today };
  if (p === "ytd") return { from: `${now.getFullYear()}-01-01`, to: today };
  if (p === "qtd") {
    const q = Math.floor(now.getMonth() / 3) * 3;
    return { from: iso(new Date(Date.UTC(now.getFullYear(), q, 1))), to: today };
  }
  const y = new Date(now);
  y.setFullYear(y.getFullYear() - 1);
  return { from: iso(y), to: today };
}

/** Base = last point BEFORE `from` (the prior close) or the first point; end = last point on/before `to`. */
function retOver(h: PimDailyReturn[], from: string | null, to: string) {
  if (h.length < 2) return { pct: null as number | null, base: null as string | null, end: null as string | null, partial: false };
  const endPt = [...h].reverse().find((p) => p.date <= to);
  const before = from ? [...h].reverse().find((p) => p.date < from) : undefined;
  const basePt = before ?? h[0];
  const partial = !!from && !before;
  if (!endPt || endPt.date <= basePt.date || !(basePt.value > 0)) return { pct: null, base: basePt?.date ?? null, end: endPt?.date ?? null, partial };
  return { pct: (endPt.value / basePt.value - 1) * 100, base: basePt.date, end: endPt.date, partial };
}

const fmt = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const tone = (v: number | null) => (v == null ? "text-ink-3" : v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-ink-2");

export function SleeveTracking() {
  const [perf, setPerf] = useState<PimPerformanceData | null | undefined>(undefined);
  const [unitBooks, setUnitBooks] = useState<Set<string>>(new Set());
  const [preset, setPreset] = useState<Preset>("ytd");
  const [custom, setCustom] = useState({ from: "", to: "" });

  useEffect(() => {
    let live = true;
    Promise.all([fetch("/api/kv/pim-performance").then((r) => r.json()), fetch("/api/kv/pim-positions").then((r) => r.json())])
      .then(([p, pos]: [PimPerformanceData, { portfolios?: { groupId: string; profile: string; positions: { units: number }[] }[] }]) => {
        if (!live) return;
        setPerf(p && Array.isArray(p.models) ? p : null);
        setUnitBooks(new Set((pos.portfolios ?? []).filter((b) => b.groupId === "pim" && b.positions.some((x) => x.units > 0)).map((b) => b.profile)));
      })
      .catch(() => live && setPerf(null));
    return () => {
      live = false;
    };
  }, []);

  const series = useMemo(() => {
    const out: Record<string, PimDailyReturn[]> = {};
    for (const b of BOOKS) out[b.profile] = perf?.models.find((m) => m.groupId === "pim" && m.profile === b.profile)?.history ?? [];
    return out;
  }, [perf]);
  const range = rangeFor(preset, custom);
  const coreR = retOver(series.core ?? [], range.from, range.to);
  const firstDate = Object.values(series).map((h) => h[0]?.date).filter(Boolean).sort()[0];

  return (
    <section className="panel">
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Sleeves vs Core</span>
        <span className="m">From the Positioning books · the same daily series as the Performance table</span>
      </div>
      {perf === undefined ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">Loading…</p>
      ) : !perf ? (
        <p className="px-3.5 py-3 text-[12.5px] text-ink-3">No performance series on file.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 px-3.5 pt-2.5">
            <div className="seg">
              {PRESETS.map((p) => (
                <button key={p.key} className={preset === p.key ? "on" : ""} onClick={() => setPreset(p.key)}>
                  {p.label}
                </button>
              ))}
            </div>
            {preset === "custom" && (
              <span className="flex flex-wrap items-center gap-1.5 text-[12.5px] text-ink-3">
                From
                <input type="date" value={custom.from} min={firstDate} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
                to
                <input type="date" value={custom.to} min={custom.from || undefined} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} className="h-7 rounded-control border border-line bg-surface px-2 text-[12.5px] text-ink" />
                <span className="text-ink-faint">(empty &quot;from&quot; = from the start, i.e. as of the &quot;to&quot; date; empty &quot;to&quot; = today)</span>
              </span>
            )}
            <span className="text-[12px] text-ink-3">{coreR.base && coreR.end ? `From the ${coreR.base} close to the ${coreR.end} close` : "Not enough history for this period"}</span>
          </div>
          <div className="tbl-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="pl-3.5">Book</th>
                  <th>Period</th>
                  <th className="n">Return</th>
                  <th className="n">vs Core</th>
                  <th>Tracked on</th>
                </tr>
              </thead>
              <tbody>
                {BOOKS.map((b) => {
                  const h = series[b.profile] ?? [];
                  const r = retOver(h, range.from, range.to);
                  const vs = b.profile === "core" || r.pct == null || coreR.pct == null || r.base !== coreR.base ? null : r.pct - coreR.pct;
                  const slice = h.filter((p) => (!r.base || p.date >= r.base) && p.date <= range.to);
                  return (
                    <tr key={b.profile}>
                      <td className="pl-3.5">
                        <span className="font-medium">{b.label}</span>
                        <div className="text-[11px] text-ink-3">{b.note}{r.partial && r.base ? ` · from ${r.base} (series starts then)` : ""}</div>
                      </td>
                      <td>
                        <Sparkline points={slice.map((p) => ({ date: p.date, value: p.value }))} width={140} height={28} />
                      </td>
                      <td className={`n ${tone(r.pct)}`}>{fmt(r.pct)}</td>
                      <td className={`n ${tone(vs)}`}>
                        {b.profile === "core" ? "—" : vs == null ? (r.pct != null && coreR.pct != null ? <span className="text-[11px] text-ink-3">different start</span> : "—") : `${vs > 0 ? "+" : ""}${vs.toFixed(2)} pts`}
                      </td>
                      <td className="text-[12px]">
                        {unitBooks.has(b.profile) ? <span className="text-ink-2">units (live weights)</span> : <span className="text-warn">model weights — add units on Positioning</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
