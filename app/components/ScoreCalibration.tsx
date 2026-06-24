"use client";

import React, { useCallback, useEffect, useState } from "react";
import type { CalibrationResult } from "@/app/lib/score-calibration";

/**
 * "Does the score work?" — realized forward return by rating bucket + a
 * per-category signal breakdown, from /api/score-calibration (which joins
 * score-history to Yahoo price history). Collapsed by default; the expensive
 * compute runs only when first opened, and the result is cached server-side.
 */

const HORIZONS = [
  { label: "1 month", days: 30 },
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
];

type Payload = { generatedAt?: string; horizonDays?: number; result?: CalibrationResult; cached?: boolean; note?: string; error?: string };

function pct(n: number | null | undefined, signed = true): string {
  if (n == null) return "—";
  const r = Number(n.toFixed(1));
  return (signed && r > 0 ? "+" : "") + r + "%";
}

/** Centered zero-line bar: positive extends right (emerald), negative left (red). */
function Bar({ value, maxAbs }: { value: number; maxAbs: number }) {
  const w = maxAbs > 0 ? (Math.abs(value) / maxAbs) * 50 : 0;
  const pos = value >= 0;
  return (
    <div className="relative h-3.5 flex-1 bg-slate-50 rounded">
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-300" />
      <div
        className={`absolute top-0 bottom-0 rounded ${pos ? "bg-emerald-400" : "bg-red-400"}`}
        style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </div>
  );
}

export function ScoreCalibration() {
  const [collapsed, setCollapsed] = useState(true);
  const [horizon, setHorizon] = useState(91);
  const [data, setData] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (h: number, refresh = false) => {
    setLoading(true);
    try {
      const r = await fetch(`/api/score-calibration?horizon=${h}${refresh ? "&refresh=1" : ""}`).then((x) => x.json());
      setData(r);
    } catch {
      setData({ error: "Failed to load" });
    } finally {
      setLoading(false);
    }
  }, []);

  // Lazy: only fetch once opened, and when the horizon changes while open.
  useEffect(() => { if (!collapsed) void load(horizon); }, [collapsed, horizon, load]);

  const res = data?.result;
  const bucketMax = res ? Math.max(1, ...res.buckets.map((b) => Math.abs(b.avgReturn))) : 1;
  const catMax = res ? Math.max(1, ...res.categories.map((c) => Math.abs(c.spread))) : 1;
  const thin = res ? res.totalObservations < 12 : false;

  return (
    <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
      <button onClick={() => setCollapsed((c) => !c)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-slate-50/60 transition-colors">
        <span className="text-sm font-semibold text-slate-700">Does the score work?</span>
        <span className="text-[11px] text-slate-400">{collapsed ? "Show" : "Hide"}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-[11px] text-slate-500">Realized return by rating, trailing history</span>
            <div className="ml-auto flex items-center gap-2">
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className="text-[11px] rounded border border-slate-200 bg-white px-1.5 py-1 text-slate-600">
                {HORIZONS.map((h) => <option key={h.days} value={h.days}>{h.label}</option>)}
              </select>
              <button onClick={() => void load(horizon, true)} disabled={loading} className="text-[11px] rounded border border-slate-200 px-2 py-1 text-slate-600 hover:bg-slate-50 disabled:opacity-50">
                {loading ? "Computing…" : "Refresh"}
              </button>
            </div>
          </div>

          {loading && !res ? (
            <p className="text-sm text-slate-400 italic py-3">Computing — fetching price history…</p>
          ) : !res || res.totalObservations === 0 ? (
            <p className="text-sm text-slate-400 italic py-3">{data?.note || "Not enough score history yet. This builds up as you rescore names over time."}</p>
          ) : (
            <>
              {thin && (
                <div className="mb-3 text-[11.5px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5">
                  Preliminary — only {res.totalObservations} matured observations so far. Treat as directional; it sharpens as history accumulates.
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <div className="bg-slate-50 rounded-md px-3 py-2">
                  <div className="text-[11px] text-slate-500">Buy hit-rate</div>
                  <div className="text-xl font-semibold text-slate-800">{res.headline.buyHitRate == null ? "—" : `${res.headline.buyHitRate}%`}</div>
                  <div className="text-[10px] text-slate-400">beat the index</div>
                </div>
                <div className="bg-slate-50 rounded-md px-3 py-2">
                  <div className="text-[11px] text-slate-500">Strong Buy avg</div>
                  <div className="text-xl font-semibold text-emerald-600">{pct(res.headline.strongBuyAvg)}</div>
                </div>
                <div className="bg-slate-50 rounded-md px-3 py-2">
                  <div className="text-[11px] text-slate-500">Sell avg</div>
                  <div className="text-xl font-semibold text-red-600">{pct(res.headline.sellAvg)}</div>
                </div>
                <div className="bg-slate-50 rounded-md px-3 py-2">
                  <div className="text-[11px] text-slate-500">Buy − Sell spread</div>
                  <div className="text-xl font-semibold text-slate-800">{res.headline.buyMinusSell == null ? "—" : pct(res.headline.buyMinusSell)}</div>
                  <div className="text-[10px] text-slate-400">excess, discrimination</div>
                </div>
              </div>

              <div className="text-[11px] text-slate-500 mb-1.5">Avg {res.horizonDays >= 182 ? "6-month" : res.horizonDays >= 91 ? "3-month" : "1-month"} return by rating bucket</div>
              <div className="space-y-1.5 mb-4">
                {res.buckets.map((b) => (
                  <div key={b.bucket} className="flex items-center gap-2 text-[12.5px]">
                    <span className="w-24 text-slate-600 shrink-0">{b.bucket}</span>
                    <Bar value={b.avgReturn} maxAbs={bucketMax} />
                    <span className={`w-12 text-right font-mono shrink-0 ${b.avgReturn >= 0 ? "text-emerald-600" : "text-red-600"}`}>{b.n ? pct(b.avgReturn) : "—"}</span>
                    <span className="w-10 text-right text-slate-400 font-mono shrink-0 text-[11px]">n={b.n}</span>
                  </div>
                ))}
              </div>

              {res.categories.length > 0 && (
                <>
                  <div className="text-[11px] text-slate-500 mb-1.5">Which categories carry signal <span className="text-slate-400">(return when above-median vs below-median)</span></div>
                  <div className="space-y-1.5">
                    {res.categories.slice(0, 7).map((c) => (
                      <div key={c.key} className="flex items-center gap-2 text-[12.5px]">
                        <span className="w-28 text-slate-600 shrink-0 truncate" title={c.label}>{c.label}</span>
                        <Bar value={c.spread} maxAbs={catMax} />
                        <span className={`w-12 text-right font-mono shrink-0 ${c.spread >= 0 ? "text-emerald-600" : "text-red-600"}`}>{pct(c.spread)}</span>
                        <span className="w-10 text-right text-slate-400 font-mono shrink-0 text-[11px]">n={c.n}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {data?.generatedAt && (
                <div className="text-[10px] text-slate-400 mt-3">
                  Computed {new Date(data.generatedAt).toLocaleString()}{data.cached ? " (cached)" : ""} · benchmark SPY · {res.totalObservations} observations
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
