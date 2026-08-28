"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
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
    <div className="relative h-3.5 flex-1 bg-surface-2 rounded">
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-line" />
      <div
        className={`absolute top-0 bottom-0 rounded ${pos ? "bg-pos" : "bg-neg"}`}
        style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </div>
  );
}

export function ScoreCalibration() {
  const { uiPrefs, setUiPref } = useStocks();
  const collapsed = (uiPrefs["dashboard.scoreCalibration.collapsed"] ?? "1") === "1";
  const setCollapsed = (fn: (c: boolean) => boolean) =>
    setUiPref("dashboard.scoreCalibration.collapsed", fn(collapsed) ? "1" : "0");
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
    <div className="rounded-lg border border-line bg-white overflow-hidden">
      <button onClick={() => setCollapsed((c) => !c)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-hover transition-colors">
        <span className="text-sm font-semibold text-ink">Does the score work?</span>
        <span className="text-[11px] text-ink-3">{collapsed ? "Show" : "Hide"}</span>
      </button>

      {!collapsed && (
        <div className="px-4 pb-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <span className="text-[11px] text-ink-3">Realized return by rating, trailing history</span>
            <div className="ml-auto flex items-center gap-2">
              <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className="text-[11px] rounded border border-line bg-white px-1.5 py-1 text-ink-2">
                {HORIZONS.map((h) => <option key={h.days} value={h.days}>{h.label}</option>)}
              </select>
              <button onClick={() => void load(horizon, true)} disabled={loading} className="text-[11px] rounded border border-line px-2 py-1 text-ink-2 hover:bg-surface-2 disabled:opacity-50">
                {loading ? "Computing…" : "Refresh"}
              </button>
            </div>
          </div>

          {loading && !res ? (
            <p className="text-sm text-ink-3 italic py-3">Computing — fetching price history…</p>
          ) : !res || res.totalObservations === 0 ? (
            <p className="text-sm text-ink-3 italic py-3">{data?.note || "Not enough score history yet. This builds up as you rescore names over time."}</p>
          ) : (
            <>
              {thin && (
                <div className="mb-3 text-[11.5px] text-warn bg-warn-soft border border-warn-border rounded px-2.5 py-1.5">
                  Preliminary — only {res.totalObservations} matured observations so far. Treat as directional; it sharpens as history accumulates.
                </div>
              )}

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <div className="bg-surface-2 rounded-md px-3 py-2">
                  <div className="text-[11px] text-ink-3">Buy hit-rate</div>
                  <div className="text-xl font-semibold text-ink">{res.headline.buyHitRate == null ? "—" : `${res.headline.buyHitRate}%`}</div>
                  <div className="text-[10px] text-ink-3">beat the index</div>
                </div>
                <div className="bg-surface-2 rounded-md px-3 py-2">
                  <div className="text-[11px] text-ink-3">Strong Buy avg</div>
                  <div className="text-xl font-semibold text-pos">{pct(res.headline.strongBuyAvg)}</div>
                </div>
                <div className="bg-surface-2 rounded-md px-3 py-2">
                  <div className="text-[11px] text-ink-3">Sell avg</div>
                  <div className="text-xl font-semibold text-neg">{pct(res.headline.sellAvg)}</div>
                </div>
                <div className="bg-surface-2 rounded-md px-3 py-2">
                  <div className="text-[11px] text-ink-3">Buy − Sell spread</div>
                  <div className="text-xl font-semibold text-ink">{res.headline.buyMinusSell == null ? "—" : pct(res.headline.buyMinusSell)}</div>
                  <div className="text-[10px] text-ink-3">excess, discrimination</div>
                </div>
              </div>

              {/* Rubric-era mix — pooled numbers above average across scoring
                  regimes; make the composition explicit so they're read with
                  that caveat. Absent on results cached before eras existed. */}
              {res.eras && res.eras.length > 0 && (
                <div className="mb-3 rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-[11px] text-ink-3">
                  <span className="font-medium text-ink-2">Rubric eras in this sample: </span>
                  {res.eras.map((e, i) => (
                    <span key={e.label}>
                      {i > 0 && " · "}
                      {e.label} n={e.n}
                      {e.buyMinusSell != null && ` (Buy−Sell ${e.buyMinusSell >= 0 ? "+" : ""}${e.buyMinusSell}%)`}
                    </span>
                  ))}
                  {res.eras.length > 1 && (
                    <span> — pooled figures mix scoring regimes; weight the newest era as evidence accumulates.</span>
                  )}
                </div>
              )}

              <div className="text-[11px] text-ink-3 mb-1.5">Avg {res.horizonDays >= 182 ? "6-month" : res.horizonDays >= 91 ? "3-month" : "1-month"} return by rating bucket</div>
              <div className="space-y-1.5 mb-4">
                {res.buckets.map((b) => (
                  <div key={b.bucket} className="flex items-center gap-2 text-[12.5px]">
                    <span className="w-24 text-ink-2 shrink-0">{b.bucket}</span>
                    <Bar value={b.avgReturn} maxAbs={bucketMax} />
                    <span className={`w-12 text-right font-mono shrink-0 ${b.avgReturn >= 0 ? "text-pos" : "text-neg"}`}>{b.n ? pct(b.avgReturn) : "—"}</span>
                    <span className="w-10 text-right text-ink-3 font-mono shrink-0 text-[11px]">n={b.n}</span>
                  </div>
                ))}
              </div>

              {res.categories.length > 0 && (
                <>
                  <div className="text-[11px] text-ink-3 mb-1.5">
                    Which categories carry signal{" "}
                    <span className="text-ink-3">(spread = above- vs below-median return · IC = rank correlation with excess return; |IC| ≥ 0.05 meaningful, ≥ 0.10 strong)</span>
                  </div>
                  <div className="space-y-1.5">
                    {res.categories.slice(0, 7).map((c) => (
                      <div key={c.key} className="flex items-center gap-2 text-[12.5px]">
                        <span className="w-28 text-ink-2 shrink-0 truncate" title={c.label}>{c.label}</span>
                        <Bar value={c.spread} maxAbs={catMax} />
                        <span className={`w-12 text-right font-mono shrink-0 ${c.spread >= 0 ? "text-pos" : "text-neg"}`}>{pct(c.spread)}</span>
                        <span
                          className={`w-16 text-right font-mono shrink-0 text-[11px] ${
                            c.ic == null ? "text-ink-faint" : Math.abs(c.ic) >= 0.1 ? (c.ic > 0 ? "text-pos" : "text-neg") : Math.abs(c.ic) >= 0.05 ? (c.ic > 0 ? "text-pos/80" : "text-neg/80") : "text-ink-3"
                          }`}
                          title={
                            c.ic == null
                              ? "Too few observations for a rank IC (needs ≥10)"
                              : `Rank IC ${c.ic >= 0 ? "+" : ""}${c.ic.toFixed(2)}: Spearman correlation between this category's score and forward excess return over ${c.n} observations. Higher |IC| = more predictive; sign shows direction.`
                          }
                        >
                          IC {c.ic == null ? "—" : `${c.ic >= 0 ? "+" : ""}${c.ic.toFixed(2)}`}
                        </span>
                        <span className="w-10 text-right text-ink-3 font-mono shrink-0 text-[11px]">n={c.n}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* ── Redundancy matrix: are the categories independent signals? ── */}
              {res.categoryCorr && res.categoryCorr.keys.length >= 2 && (
                <>
                  <div className="mt-4 mb-1 flex items-baseline gap-2">
                    <h4 className="text-xs font-semibold text-ink">Category overlap</h4>
                    <span className="text-[10px] text-ink-3">
                      correlation between sub-scores · ≥ 0.6 means two lines are largely one signal counted twice
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="text-[10px] font-mono">
                      <thead>
                        <tr>
                          <th />
                          {res.categoryCorr.labels.map((l) => (
                            <th key={l} className="px-1 py-0.5 text-right font-semibold text-ink-3" title={l}>
                              {l.slice(0, 6)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {res.categoryCorr.keys.map((rk, i) => (
                          <tr key={rk}>
                            <td className="pr-1.5 py-0.5 font-semibold text-ink-3">{res.categoryCorr!.labels[i]}</td>
                            {res.categoryCorr!.matrix[i].map((v, j) => (
                              <td
                                key={j}
                                className={`px-1 py-0.5 text-right ${
                                  i === j || v == null
                                    ? "text-ink-faint"
                                    : Math.abs(v) >= 0.6
                                      ? "font-bold text-neg"
                                      : Math.abs(v) >= 0.4
                                        ? "text-warn"
                                        : "text-ink-2"
                                }`}
                                title={v == null ? "under 10 paired observations" : undefined}
                              >
                                {i === j ? "·" : v == null ? "—" : v.toFixed(2)}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {data?.generatedAt && (
                <div className="text-[10px] text-ink-3 mt-3">
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
