"use client";

/**
 * Stock / SPY relative-strength sparkline.
 *
 * Fetches daily bars for the stock AND for SPY from the existing
 * /api/chart-data route (same pipe StockChart uses, so no new Yahoo
 * calls added to the codebase). Aligns the two series by date,
 * computes ratio = stockClose / spyClose, normalizes so the first
 * observation of the chosen window = 1.0, and renders a lightweight
 * SVG sparkline.
 *
 * A rising line = stock outperforming SPY. Flat = matching SPY.
 * Falling = underperforming. This is the single most-asked-for read
 * in Mark Newton's toolkit ("relative strength vs the tape").
 *
 * Informational-only — does not feed risk alerts or the composite
 * score. No Redis writes.
 *
 * `useRatioVsSpx` is exported so the Price panel header can carry the
 * one-line "vs S&P 500 · relative +x% 1Y" read while the sparkline itself
 * sits one persisted click away under the chart.
 */

import React, { useCallback, useEffect, useState } from "react";

type Bar = { date: string; close: number };

export type RatioPoint = { date: string; ratio: number };

export function useRatioVsSpx(ticker: string, windowDays = 252) {
  // Skip entirely when ticker *is* SPY/SPX (plotting SPY vs itself is meaningless).
  const isBenchmark = !ticker || ticker.toUpperCase() === "SPY" || ticker.toUpperCase() === "SPX";
  const [loading, setLoading] = useState(!isBenchmark);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<RatioPoint[]>([]);

  const fetchRatio = useCallback(async () => {
    if (isBenchmark) return;
    setLoading(true);
    setError(null);
    try {
      const [stockRes, spyRes] = await Promise.all([
        fetch(`/api/chart-data?ticker=${encodeURIComponent(ticker)}`),
        fetch(`/api/chart-data?ticker=SPY`),
      ]);
      if (!stockRes.ok || !spyRes.ok) throw new Error("fetch failed");
      const [stockData, spyData] = await Promise.all([stockRes.json(), spyRes.json()]);
      const stockBars: Bar[] = (stockData.bars ?? []).map((b: Bar) => ({ date: b.date, close: b.close }));
      const spyBars: Bar[] = (spyData.bars ?? []).map((b: Bar) => ({ date: b.date, close: b.close }));
      const spyByDate = new Map(spyBars.map((b) => [b.date, b.close]));

      // Align by date, take last `windowDays` observations.
      const aligned: RatioPoint[] = [];
      for (const b of stockBars) {
        const spyClose = spyByDate.get(b.date);
        if (spyClose == null || !isFinite(spyClose) || spyClose <= 0) continue;
        if (!isFinite(b.close) || b.close <= 0) continue;
        aligned.push({ date: b.date, ratio: b.close / spyClose });
      }
      const windowed = aligned.slice(-windowDays);
      if (windowed.length < 2) {
        setSeries([]);
        return;
      }
      // Normalize to 1.0 at the start of the window — makes cross-ticker
      // comparison visually intuitive (above 1.0 = outperforming since
      // window start; below 1.0 = underperforming).
      const base = windowed[0].ratio;
      setSeries(windowed.map((r) => ({ date: r.date, ratio: r.ratio / base })));
    } catch {
      setError("Unable to load ratio data");
    } finally {
      setLoading(false);
    }
  }, [ticker, windowDays, isBenchmark]);

  useEffect(() => {
    fetchRatio();
  }, [fetchRatio]);

  const first = series[0]?.ratio;
  const last = series[series.length - 1]?.ratio;
  const pctChange = first != null && last != null ? ((last - first) / first) * 100 : null;
  const daysShown = series.length;
  const approxMonths = Math.round(daysShown / 21);
  const windowLabel = daysShown === 0 ? "" : approxMonths >= 12 ? `${Math.round(approxMonths / 12)}Y` : `${approxMonths}M`;

  return { isBenchmark, loading, error, series, pctChange, windowLabel };
}

type Props = {
  ticker: string;
  /** Trailing window in trading days. Defaults to 252 (~1Y). */
  windowDays?: number;
  className?: string;
  /** Pre-fetched result from `useRatioVsSpx` so the header meta and the
   *  sparkline share one fetch. When omitted the component fetches itself. */
  data?: ReturnType<typeof useRatioVsSpx>;
};

function Sparkline({ series }: { series: RatioPoint[] }) {
  const firstRatio = series[0].ratio;
  const lastRatio = series[series.length - 1].ratio;
  const isOutperforming = lastRatio >= firstRatio;

  // Sparkline path generation — simple SVG linear interpolation.
  const W = 600;
  const H = 72;
  const PAD = 4;
  const minR = Math.min(...series.map((s) => s.ratio));
  const maxR = Math.max(...series.map((s) => s.ratio));
  const range = Math.max(maxR - minR, 1e-6);
  const xFor = (i: number) => PAD + (i / (series.length - 1)) * (W - 2 * PAD);
  const yFor = (r: number) => PAD + (1 - (r - minR) / range) * (H - 2 * PAD);
  const d = series.map((pt, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)},${yFor(pt.ratio).toFixed(2)}`).join(" ");
  const baselineY = yFor(1);
  const lineColor = isOutperforming ? "var(--color-pos)" : "var(--color-neg)";
  const areaPath = `${d} L${xFor(series.length - 1).toFixed(2)},${H - PAD} L${xFor(0).toFixed(2)},${H - PAD} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none">
      {/* Baseline at ratio = 1.0 (parity with SPY at window start) */}
      <line x1={PAD} x2={W - PAD} y1={baselineY} y2={baselineY} stroke="var(--color-ink-faint)" strokeWidth={1} strokeDasharray="3,3" />
      <path d={areaPath} fill={lineColor} opacity={0.08} />
      <path d={d} pathLength={1} className="spark-draw" fill="none" stroke={lineColor} strokeWidth={1.5} />
    </svg>
  );
}

export default function RatioVsSpxSparkline({ ticker, windowDays = 252, className = "", data }: Props) {
  const own = useRatioVsSpx(data ? "SPY" : ticker, windowDays);
  const r = data ?? own;

  if (r.isBenchmark) return null;

  if (r.loading) {
    return <div className={`text-[11.5px] text-ink-3 ${className}`}>Loading relative strength…</div>;
  }
  if (r.error || r.series.length < 2) {
    return <div className={`text-[11.5px] text-ink-3 ${className}`}>{r.error ?? "Not enough overlapping data to plot relative strength"}</div>;
  }

  const pct = r.pctChange ?? 0;
  const isOutperforming = pct >= 0;

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[11.5px] text-ink-3">
          Relative strength vs S&amp;P 500 (SPY) · ratio normalized to 1.00 at start of {r.windowLabel} window. Rising = beating the index; falling = lagging it.
        </span>
        <span className={`shrink-0 font-mono text-[12px] font-medium ${isOutperforming ? "text-pos" : "text-neg"}`}>
          {isOutperforming ? "+" : ""}{pct.toFixed(1)}% · {isOutperforming ? "outperforming" : "underperforming"}
        </span>
      </div>
      <Sparkline series={r.series} />
      <div className="mt-0.5 flex items-center justify-between font-mono text-[10.5px] text-ink-3">
        <span>{r.series[0].date}</span>
        <span>{r.series[r.series.length - 1].date}</span>
      </div>
    </div>
  );
}
