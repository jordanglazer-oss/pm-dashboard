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
 */

import React, { useCallback, useEffect, useState } from "react";

type Bar = { date: string; close: number };

type Props = {
  ticker: string;
  /** Trailing window in trading days. Defaults to 252 (~1Y). */
  windowDays?: number;
  className?: string;
};

export default function RatioVsSpxSparkline({ ticker, windowDays = 252, className = "" }: Props) {
  // Skip entirely when ticker *is* SPY/SPX (plotting SPY vs itself is meaningless).
  const isBenchmark = !ticker || ticker.toUpperCase() === "SPY" || ticker.toUpperCase() === "SPX";
  const [loading, setLoading] = useState(!isBenchmark);
  const [error, setError] = useState<string | null>(null);
  const [series, setSeries] = useState<{ date: string; ratio: number }[]>([]);

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
      const aligned: { date: string; ratio: number }[] = [];
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

  if (isBenchmark) return null;

  // ── Render ──
  if (loading) {
    return (
      <div className={`rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
        <div className="text-sm font-bold text-slate-700 mb-2">Relative Strength vs S&amp;P 500 (SPY)</div>
        <div className="text-xs text-slate-400">{"Loading\u2026"}</div>
      </div>
    );
  }
  if (error || series.length < 2) {
    return (
      <div className={`rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
        <div className="text-sm font-bold text-slate-700 mb-2">Relative Strength vs S&amp;P 500 (SPY)</div>
        <div className="text-xs text-slate-400">{error ?? "Not enough overlapping data to plot"}</div>
      </div>
    );
  }

  const firstRatio = series[0].ratio;
  const lastRatio = series[series.length - 1].ratio;
  const pctChange = (lastRatio - firstRatio) / firstRatio * 100;
  const isOutperforming = lastRatio >= 1;

  // Sparkline path generation — simple SVG linear interpolation.
  const W = 600;
  const H = 80;
  const PAD = 4;
  const minR = Math.min(...series.map((s) => s.ratio));
  const maxR = Math.max(...series.map((s) => s.ratio));
  const range = Math.max(maxR - minR, 1e-6);
  const xFor = (i: number) => PAD + (i / (series.length - 1)) * (W - 2 * PAD);
  const yFor = (r: number) => PAD + (1 - (r - minR) / range) * (H - 2 * PAD);
  const d = series.map((pt, i) => `${i === 0 ? "M" : "L"}${xFor(i).toFixed(2)},${yFor(pt.ratio).toFixed(2)}`).join(" ");
  const baselineY = yFor(1);
  const lineColor = isOutperforming ? "#059669" /* emerald-600 */ : "#dc2626" /* red-600 */;
  const fillColor = isOutperforming ? "rgba(5,150,105,0.08)" : "rgba(220,38,38,0.08)";
  const areaPath = `${d} L${xFor(series.length - 1).toFixed(2)},${H - PAD} L${xFor(0).toFixed(2)},${H - PAD} Z`;

  // Window label
  const daysShown = series.length;
  const approxMonths = Math.round(daysShown / 21);
  const windowLabel = approxMonths >= 12 ? `${Math.round(approxMonths / 12)}Y` : `${approxMonths}M`;

  return (
    <div className={`rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      <div className="flex items-start justify-between mb-2">
        <div>
          <div className="text-sm font-bold text-slate-700">Relative Strength vs S&amp;P 500 (SPY)</div>
          <div className="text-[11px] text-slate-400">Ratio normalized to 1.00 at start of {windowLabel} window</div>
        </div>
        <div className="text-right">
          <div className={`text-sm font-bold ${isOutperforming ? "text-emerald-600" : "text-red-600"}`}>
            {isOutperforming ? "Outperforming" : "Underperforming"}
          </div>
          <div className={`text-xs font-mono ${pctChange >= 0 ? "text-emerald-600" : "text-red-600"}`}>
            {pctChange >= 0 ? "+" : ""}{pctChange.toFixed(1)}% vs SPY
          </div>
        </div>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-20" preserveAspectRatio="none">
        {/* Baseline at ratio = 1.0 (parity with SPY at window start) */}
        <line
          x1={PAD}
          x2={W - PAD}
          y1={baselineY}
          y2={baselineY}
          stroke="#cbd5e1"
          strokeWidth={1}
          strokeDasharray="3,3"
        />
        <path d={areaPath} fill={fillColor} />
        <path d={d} fill="none" stroke={lineColor} strokeWidth={1.75} />
      </svg>
      <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
        <span>{series[0].date}</span>
        <span>{series[series.length - 1].date}</span>
      </div>
    </div>
  );
}
