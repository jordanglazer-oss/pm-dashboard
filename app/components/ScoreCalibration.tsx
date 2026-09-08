"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useStocks } from "@/app/lib/StockContext";
import { AppIcon } from "@/app/components/AppIcon";
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

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover hover:text-ink disabled:opacity-50 transition-colors";
const INPUT = "h-7 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2";

function pct(n: number | null | undefined, signed = true): string {
  if (n == null) return "—";
  const r = Number(n.toFixed(1));
  return (signed && r > 0 ? "+" : "") + r + "%";
}

/** Centered zero-line bar: positive extends right (pos), negative left (neg). */
function Bar({ value, maxAbs }: { value: number; maxAbs: number }) {
  const w = maxAbs > 0 ? (Math.abs(value) / maxAbs) * 50 : 0;
  const pos = value >= 0;
  return (
    <div className="relative h-1.5 flex-1 rounded bg-surface-2">
      <div className="absolute top-0 bottom-0 left-1/2 w-px bg-line" />
      <div
        className={`absolute top-0 bottom-0 rounded ${pos ? "bg-pos" : "bg-neg"}`}
        style={pos ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
      />
    </div>
  );
}

function Stat({ label, value, tone, sub }: { label: string; value: string; tone?: string; sub?: string }) {
  return (
    <div className="px-3.5 py-2.5">
      <div className="text-[11px] text-ink-3">{label}</div>
      <div className={`font-mono text-[13px] font-medium ${tone ?? "text-ink"}`}>{value}</div>
      {sub && <div className="text-[11px] text-ink-3">{sub}</div>}
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
  const horizonWord = res ? (res.horizonDays >= 182 ? "6-month" : res.horizonDays >= 91 ? "3-month" : "1-month") : "";

  return (
    <section className="panel">
      <div className={`panel-h ${collapsed ? "border-b-0" : ""}`}>
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <AppIcon name="chevD" size={14} strokeWidth={2} className={`shrink-0 text-ink-3 transition-transform duration-200 group-hover:text-ink-2 ${collapsed ? "-rotate-90" : ""}`} />
          <span className="t">Does the score work?</span>
          <span className="m truncate">Realized return by rating, trailing history</span>
        </button>
        {!collapsed && (
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <select value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} className={INPUT}>
              {HORIZONS.map((h) => <option key={h.days} value={h.days}>{h.label}</option>)}
            </select>
            <button type="button" onClick={() => void load(horizon, true)} disabled={loading} className={BTN}>
              <AppIcon name="refresh" size={13} strokeWidth={2} className={loading ? "animate-spin" : ""} />
              {loading ? "Computing…" : "Refresh"}
            </button>
          </div>
        )}
      </div>

      {!collapsed && (
        loading && !res ? (
          <p className="px-3.5 py-6 text-[12.5px] text-ink-3">Computing — fetching price history…</p>
        ) : !res || res.totalObservations === 0 ? (
          <p className="px-3.5 py-6 text-[12.5px] text-ink-3">{data?.note || "Not enough score history yet. This builds up as you rescore names over time."}</p>
        ) : (
          <>
            {thin && (
              <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2 text-[11.5px] text-warn">
                <span className="dot bg-warn" />
                Preliminary — only {res.totalObservations} matured observations so far. Treat as directional; it sharpens as history accumulates.
              </div>
            )}

            {/* One hairline stat strip, not a grid of tiles. */}
            <div className="grid grid-cols-2 divide-x divide-line-soft border-b border-line-soft sm:grid-cols-4">
              <Stat label="Buy hit-rate" value={res.headline.buyHitRate == null ? "—" : `${res.headline.buyHitRate}%`} sub="beat the index" />
              <Stat label="Strong Buy avg" value={pct(res.headline.strongBuyAvg)} tone="text-pos" />
              <Stat label="Sell avg" value={pct(res.headline.sellAvg)} tone="text-neg" />
              <Stat label="Buy − Sell spread" value={res.headline.buyMinusSell == null ? "—" : pct(res.headline.buyMinusSell)} sub="excess, discrimination" />
            </div>

            {/* Rubric-era mix — pooled numbers above average across scoring
                regimes; make the composition explicit so they're read with
                that caveat. Absent on results cached before eras existed. */}
            {res.eras && res.eras.length > 0 && (
              <div className="border-b border-line-soft px-3.5 py-2 text-[11.5px] text-ink-3">
                <span className="text-ink-2">Rubric eras in this sample: </span>
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

            <div className="px-3.5 py-3">
              <div className="mb-1.5 text-[11px] text-ink-3">Avg {horizonWord} return by rating bucket</div>
              <div className="space-y-1.5">
                {res.buckets.map((b) => (
                  <div key={b.bucket} className="flex items-center gap-2 text-[12.5px]">
                    <span className="w-24 shrink-0 text-ink-2">{b.bucket}</span>
                    <Bar value={b.avgReturn} maxAbs={bucketMax} />
                    <span className={`w-12 shrink-0 text-right font-mono tabular-nums ${b.avgReturn >= 0 ? "text-pos" : "text-neg"}`}>{b.n ? pct(b.avgReturn) : "—"}</span>
                    <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-3">n={b.n}</span>
                  </div>
                ))}
              </div>
            </div>

            {res.categories.length > 0 && (
              <div className="border-t border-line-soft px-3.5 py-3">
                <div className="mb-1.5 text-[11px] text-ink-3">
                  Which categories carry signal{" "}
                  <span>(spread = above- vs below-median return · IC = rank correlation with excess return; |IC| ≥ 0.05 meaningful, ≥ 0.10 strong)</span>
                </div>
                <div className="space-y-1.5">
                  {res.categories.slice(0, 7).map((c) => (
                    <div key={c.key} className="flex items-center gap-2 text-[12.5px]">
                      <span className="w-28 shrink-0 truncate text-ink-2" title={c.label}>{c.label}</span>
                      <Bar value={c.spread} maxAbs={catMax} />
                      <span className={`w-12 shrink-0 text-right font-mono tabular-nums ${c.spread >= 0 ? "text-pos" : "text-neg"}`}>{pct(c.spread)}</span>
                      <span
                        className={`w-16 shrink-0 text-right font-mono text-[11px] tabular-nums ${
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
                      <span className="w-10 shrink-0 text-right font-mono text-[11px] tabular-nums text-ink-3">n={c.n}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Redundancy matrix: are the categories independent signals? ── */}
            {res.categoryCorr && res.categoryCorr.keys.length >= 2 && (
              <div className="border-t border-line-soft px-3.5 py-3">
                <div className="mb-1.5 flex flex-wrap items-baseline gap-2">
                  <span className="text-[12px] font-semibold text-ink">Category overlap</span>
                  <span className="text-[11px] text-ink-3">
                    correlation between sub-scores · ≥ 0.6 means two lines are largely one signal counted twice
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="font-mono text-[11px] tabular-nums">
                    <thead>
                      <tr>
                        <th />
                        {res.categoryCorr.labels.map((l) => (
                          <th key={l} className="px-1.5 py-0.5 text-right font-medium text-ink-3" title={l}>
                            {l.slice(0, 6)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {res.categoryCorr.keys.map((rk, i) => (
                        <tr key={rk}>
                          <td className="py-0.5 pr-2 font-medium text-ink-3">{res.categoryCorr!.labels[i]}</td>
                          {res.categoryCorr!.matrix[i].map((v, j) => (
                            <td
                              key={j}
                              className={`px-1.5 py-0.5 text-right ${
                                i === j || v == null
                                  ? "text-ink-faint"
                                  : Math.abs(v) >= 0.6
                                    ? "font-medium text-neg"
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
              </div>
            )}

            {data?.generatedAt && (
              <div className="flex h-8 items-center border-t border-line-soft px-3.5 text-[11.5px] text-ink-3">
                Computed {new Date(data.generatedAt).toLocaleString()}{data.cached ? " (cached)" : ""} · benchmark SPY · {res.totalObservations} observations
              </div>
            )}
          </>
        )
      )}
    </section>
  );
}
