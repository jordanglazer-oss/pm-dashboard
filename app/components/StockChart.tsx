"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import type { TechnicalIndicators } from "@/app/lib/technicals";
import { useStocks } from "@/app/lib/StockContext";
import { usePersistedOpen } from "@/app/lib/useCollapsed";
import { AppIcon } from "@/app/components/AppIcon";
import RatioVsSpxSparkline, { useRatioVsSpx } from "@/app/components/RatioVsSpxSparkline";

type ViewRange = "1mo" | "3mo" | "6mo" | "1y" | "2y" | "5y" | "10y" | "all";

const RANGES: { key: ViewRange; label: string }[] = [
  { key: "1mo", label: "1M" },
  { key: "3mo", label: "3M" },
  { key: "6mo", label: "6M" },
  { key: "1y", label: "1Y" },
  { key: "2y", label: "2Y" },
  { key: "5y", label: "5Y" },
  { key: "10y", label: "10Y" },
  { key: "all", label: "MAX" },
];

function rangeToMonths(r: ViewRange): number | null {
  switch (r) {
    case "1mo": return 1;
    case "3mo": return 3;
    case "6mo": return 6;
    case "1y": return 12;
    case "2y": return 24;
    case "5y": return 60;
    case "10y": return 120;
    case "all": return null; // fit all
  }
}

type ChartData = {
  bars: { date: string; open: number; high: number; low: number; close: number; volume: number }[];
  sma50: { date: string; value: number }[];
  sma200: { date: string; value: number }[];
};

type Props = {
  ticker: string;
  technicals?: TechnicalIndicators;
  className?: string;
  /** Latest-bar change vs the prior close (%), reported once the bars land
   *  so the identity row can show a signed day move without a second fetch.
   *  Null when fewer than two bars are available. */
  onDayChange?: (pct: number | null) => void;
};

// Chart-library colours have to be literals (lightweight-charts paints a
// canvas), so these mirror the @theme tokens in app/globals.css.
const C = {
  surface: "#ffffff",
  ink3: "#8a93a2",
  inkFaint: "#c4cad3",
  line: "#e4e7ec",
  lineSoft: "#eef0f4",
  accent: "#2d5bd0",
  pos: "#12805c",
  neg: "#cc3f57",
  posSoft: "rgba(18, 128, 92, 0.28)",
  negSoft: "rgba(204, 63, 87, 0.28)",
};

const CHART_HEIGHT = 320;

const OUTLOOK_TONE: Record<string, string> = {
  Bullish: "bg-pos-soft text-pos",
  Bearish: "bg-neg-soft text-neg",
};

const BTN = "inline-flex h-7 items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 text-[12.5px] text-ink-2 hover:bg-surface-hover transition-colors disabled:opacity-50";

export default function StockChart({ ticker, technicals, className = "", onDayChange }: Props) {
  const { chartAnalyses, setChartAnalysis, clearChartAnalysis, uiPrefs, setUiPref } = useStocks();
  // Analysis body collapses to just the header (persisted) — the chart
  // section was eating half the page.
  const chartAnalysisCollapsed = (uiPrefs["stock.chartAnalysis.collapsed"] ?? "1") === "1";
  // Relative-strength sparkline sits one persisted click away under the
  // chart; the one-line read lives in the panel header regardless.
  const [ratioOpen, toggleRatio] = usePersistedOpen("stock.ratioVsSpx.open", false);
  const ratio = useRatioVsSpx(ticker);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  const [viewRange, setViewRange] = useState<ViewRange>("1y");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [chartData, setChartData] = useState<ChartData | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisError, setAnalysisError] = useState("");

  // Load persisted analysis for this ticker
  const savedAnalysis = chartAnalyses[ticker];
  const analysis = savedAnalysis?.analysis || null;

  // Fetch ALL chart data once on mount (daily + weekly merged by API)
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/chart-data?ticker=${encodeURIComponent(ticker)}`);
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Failed (${res.status})`);
      }
      const data: ChartData = await res.json();
      setChartData(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load chart data");
    } finally {
      setLoading(false);
    }
  }, [ticker]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Surface the latest bar's move to the parent (identity row). Derived from
  // bars already fetched — no extra request.
  const onDayChangeRef = useRef(onDayChange);
  onDayChangeRef.current = onDayChange;
  useEffect(() => {
    const cb = onDayChangeRef.current;
    if (!cb) return;
    const bars = chartData?.bars;
    if (!bars || bars.length < 2) { cb(null); return; }
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2];
    cb(prev.close ? ((last.close - prev.close) / prev.close) * 100 : null);
  }, [chartData]);

  // Zoom to the selected range
  const zoomToRange = useCallback((r: ViewRange) => {
    if (!chartRef.current || !chartData || chartData.bars.length === 0) return;

    const months = rangeToMonths(r);
    if (months === null) {
      chartRef.current.timeScale().fitContent();
      return;
    }

    const lastDate = chartData.bars[chartData.bars.length - 1].date;
    const to = new Date(lastDate);
    const from = new Date(lastDate);
    from.setMonth(from.getMonth() - months);
    const fromStr = from.toISOString().split("T")[0];

    chartRef.current.timeScale().setVisibleRange({
      from: fromStr,
      to: lastDate,
    });
  }, [chartData]);

  // When viewRange changes, zoom the chart (no re-fetch)
  useEffect(() => {
    zoomToRange(viewRange);
  }, [viewRange, zoomToRange]);

  // Render chart (only when data changes, not on zoom)
  useEffect(() => {
    if (!chartData || !containerRef.current) return;

    let disposed = false;
    // Hoisted so the effect's own cleanup can disconnect it. It used to be
    // returned from the async IIFE below, which React never calls — so every
    // chart rebuild (ticker change, data refetch) left a live ResizeObserver
    // holding a closure over the REMOVED chart. The next width change (a
    // price refresh reflowing the page, a scrollbar appearing) fired that
    // stale observer, which called applyOptions on a disposed chart and threw
    // an uncaught "Object is disposed" out of lightweight-charts.
    let ro: ResizeObserver | null = null;

    (async () => {
      const lc = await import("lightweight-charts");

      if (disposed || !containerRef.current) return;

      // Clean up previous chart
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }

      const chart = lc.createChart(containerRef.current, {
        width: containerRef.current.clientWidth,
        height: CHART_HEIGHT,
        layout: {
          background: { color: C.surface },
          textColor: C.ink3,
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: C.lineSoft },
          horzLines: { color: C.lineSoft },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: C.inkFaint, width: 1, style: lc.LineStyle.Dashed },
          horzLine: { color: C.inkFaint, width: 1, style: lc.LineStyle.Dashed },
        },
        rightPriceScale: {
          borderColor: C.line,
        },
        timeScale: {
          borderColor: C.line,
          timeVisible: false,
        },
      });

      chartRef.current = chart;

      // Candlestick series
      const candleSeries = chart.addSeries(lc.CandlestickSeries, {
        upColor: C.pos,
        downColor: C.neg,
        borderUpColor: C.pos,
        borderDownColor: C.neg,
        wickUpColor: C.pos,
        wickDownColor: C.neg,
      });

      candleSeries.setData(
        chartData.bars.map((b) => ({
          time: b.date,
          open: b.open,
          high: b.high,
          low: b.low,
          close: b.close,
        }))
      );

      // Volume series
      const volumeSeries = chart.addSeries(lc.HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
      });

      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.85, bottom: 0 },
      });

      volumeSeries.setData(
        chartData.bars.map((b) => ({
          time: b.date,
          value: b.volume,
          color: b.close >= b.open ? C.posSoft : C.negSoft,
        }))
      );

      // SMA 50 overlay (accent)
      if (chartData.sma50.length > 0) {
        const sma50Series = chart.addSeries(lc.LineSeries, {
          color: C.accent,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        sma50Series.setData(
          chartData.sma50.map((p) => ({ time: p.date, value: p.value }))
        );
      }

      // SMA 200 overlay (neg)
      if (chartData.sma200.length > 0) {
        const sma200Series = chart.addSeries(lc.LineSeries, {
          color: C.neg,
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        sma200Series.setData(
          chartData.sma200.map((p) => ({ time: p.date, value: p.value }))
        );
      }

      // Scrubbing tooltip (#14). Reuses the library's own crosshair; a floating
      // date + close/change readout follows it. pointer-events:none on the
      // tooltip keeps the crosshair firing. The subscription is disposed with
      // the chart on cleanup, so no explicit unsubscribe is needed.
      chart.subscribeCrosshairMove((param) => {
        const el = tooltipRef.current;
        if (!el) return;
        const w = containerRef.current?.clientWidth ?? 0;
        if (!param.time || !param.point || param.point.x < 0 || param.point.x > w || param.point.y < 0) {
          el.style.display = "none";
          return;
        }
        const bar = param.seriesData.get(candleSeries) as
          | { open: number; high: number; low: number; close: number }
          | undefined;
        if (!bar) { el.style.display = "none"; return; }
        const chg = bar.close - bar.open;
        const chgPct = bar.open ? (chg / bar.open) * 100 : 0;
        const col = chg >= 0 ? "var(--color-pos)" : "var(--color-neg)";
        el.innerHTML =
          `<div style="font-weight:600;color:var(--color-ink)">${String(param.time)}</div>` +
          `<div style="font-family:var(--font-mono);color:var(--color-ink-2)">$${bar.close.toFixed(2)} ` +
          `<span style="color:${col}">${chg >= 0 ? "+" : ""}${chgPct.toFixed(1)}%</span></div>`;
        el.style.display = "block";
        const tw = el.offsetWidth;
        let left = param.point.x + 14;
        if (left + tw > w) left = param.point.x - tw - 14;
        el.style.left = `${Math.max(0, left)}px`;
        el.style.top = `${Math.max(0, param.point.y - 8)}px`;
      });

      // Apply initial zoom
      const months = rangeToMonths(viewRange);
      if (months === null) {
        chart.timeScale().fitContent();
      } else {
        const lastDate = chartData.bars[chartData.bars.length - 1].date;
        const from = new Date(lastDate);
        from.setMonth(from.getMonth() - months);
        chart.timeScale().setVisibleRange({
          from: from.toISOString().split("T")[0],
          to: lastDate,
        });
      }

      // Resize observer. `disposed` is re-checked inside the callback because
      // RO deliveries are queued to the end of a frame — one can still be in
      // flight when cleanup runs.
      ro = new ResizeObserver((entries) => {
        if (disposed || chartRef.current !== chart) return;
        for (const entry of entries) {
          chart.applyOptions({ width: entry.contentRect.width });
        }
      });
      ro.observe(containerRef.current);
    })();

    return () => {
      disposed = true;
      ro?.disconnect();
      ro = null;
      if (chartRef.current) {
        chartRef.current.remove();
        chartRef.current = null;
      }
    };
  }, [chartData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Claude chart analysis
  const handleAnalyze = async () => {
    if (!chartRef.current) return;
    setAnalyzing(true);
    setAnalysisError("");
    try {
      const canvas = chartRef.current.takeScreenshot();
      const imageBase64 = canvas.toDataURL("image/png");

      const rangeLabel = RANGES.find((r) => r.key === viewRange)?.label || viewRange;

      const res = await fetch("/api/analyze-chart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticker,
          imageBase64,
          range: rangeLabel,
          technicals: technicals || undefined,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Analysis failed (${res.status})`);
      }

      const data = await res.json();
      setChartAnalysis(ticker, {
        analysis: data.analysis,
        range: viewRange,
        analyzedAt: new Date().toISOString(),
        // New structured fields — present on fresh analyses, absent on
        // saved analyses generated before this commit (which still
        // render via the legacy prose path below).
        outlook: data.outlook,
        confidence: typeof data.confidence === "number" ? data.confidence : undefined,
        bullCase: data.bullCase,
        bearCase: data.bearCase,
        support: Array.isArray(data.support) ? data.support : undefined,
        resistance: Array.isArray(data.resistance) ? data.resistance : undefined,
        stopBelow: typeof data.stopBelow === "number" ? data.stopBelow : null,
        nextAction: data.nextAction,
      });
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  // Bar count info
  const totalBars = chartData?.bars.length || 0;
  const yearsOfData = totalBars > 0
    ? Math.round((new Date(chartData!.bars[totalBars - 1].date).getTime() - new Date(chartData!.bars[0].date).getTime()) / (365.25 * 24 * 60 * 60 * 1000))
    : 0;

  const relPct = ratio.pctChange;
  const relMeta =
    ratio.isBenchmark ? null
    : ratio.loading ? "vs S&P 500 · loading…"
    : ratio.error || ratio.series.length < 2 || relPct == null ? "vs S&P 500 · no overlap"
    : null;
  const analysisRangeLabel = savedAnalysis?.range
    ? RANGES.find((r) => r.key === savedAnalysis.range)?.label || savedAnalysis.range
    : RANGES.find((r) => r.key === viewRange)?.label;

  return (
    <section className={`panel ${className}`}>
      {/* Header: title · range switcher · SMA legend · relative read · analyze */}
      <div className="panel-h flex-wrap gap-y-1.5 py-1.5">
        <span className="t">Price</span>
        <div className="seg">
          {RANGES.map((r) => (
            <button key={r.key} type="button" onClick={() => setViewRange(r.key)} className={viewRange === r.key ? "on" : ""}>
              {r.label}
            </button>
          ))}
        </div>
        <span className="hidden items-center gap-3 text-[11.5px] text-ink-3 sm:inline-flex">
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 rounded bg-accent" /> SMA 50</span>
          <span className="inline-flex items-center gap-1"><span className="inline-block h-0.5 w-3 rounded bg-neg" /> SMA 200</span>
        </span>
        {totalBars > 0 && (
          <span className="m hidden lg:inline" title="Scroll or drag inside the chart to explore the full history">{yearsOfData}+ yrs · scroll to explore</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {relMeta ? (
            <span className="m">{relMeta}</span>
          ) : relPct != null ? (
            <span className="m" title="Stock / SPY ratio, normalized to 1.00 at the start of the window. Open the relative-strength row under the chart for the line.">
              vs S&amp;P 500 · relative{" "}
              <span className={`font-mono font-medium ${relPct >= 0 ? "text-pos" : "text-neg"}`}>
                {relPct >= 0 ? "+" : ""}{relPct.toFixed(1)}%
              </span>{" "}
              {ratio.windowLabel}
            </span>
          ) : null}
          <button
            type="button"
            onClick={handleAnalyze}
            disabled={analyzing || loading || !chartData}
            className={BTN}
            title="One vision model call reads the visible chart (with the technicals) and writes a structured bull / bear / levels read. Saved per ticker."
          >
            <AppIcon name="spark" size={13} />
            {analyzing ? "Analyzing…" : "Analyze chart"}
          </button>
        </div>
      </div>

      {/* Chart body */}
      <div className="px-2 pb-1 pt-2">
        {loading && (
          <div className="flex items-center justify-center gap-2 text-[12.5px] text-ink-3" style={{ height: CHART_HEIGHT }}>
            <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-line border-t-transparent" />
            Loading chart data…
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center text-[12.5px] text-neg" style={{ height: CHART_HEIGHT }}>
            {error}
          </div>
        )}
        <div className={`relative w-full ${loading || error ? "hidden" : ""}`}>
          <div ref={containerRef} className="w-full" style={{ minHeight: CHART_HEIGHT }} />
          <div
            ref={tooltipRef}
            style={{ display: "none" }}
            className="pointer-events-none absolute z-20 rounded-control border border-line bg-surface/95 px-2 py-1 text-[11px] leading-tight shadow-[var(--shadow-pop)]"
          />
        </div>
      </div>

      {/* Relative strength vs the tape — one persisted click away */}
      {!ratio.isBenchmark && (
        <div className="border-t border-line-soft">
          <div className="flex items-center gap-2 px-3.5 py-1.5">
            <span className="text-[12.5px] font-medium text-ink">Relative strength vs S&amp;P 500</span>
            {relPct != null && !ratio.loading && !ratio.error && (
              <span className={`inline-flex items-center gap-1.5 text-[11.5px] ${relPct >= 0 ? "text-pos" : "text-neg"}`}>
                <span className={`dot ${relPct >= 0 ? "bg-pos" : "bg-neg"}`} /> {relPct >= 0 ? "Outperforming" : "Underperforming"} {ratio.windowLabel}
              </span>
            )}
            <button
              type="button"
              onClick={toggleRatio}
              className="ml-auto grid h-7 w-7 place-items-center rounded-control text-ink-3 hover:bg-surface-hover hover:text-ink"
              aria-expanded={ratioOpen}
              aria-label={ratioOpen ? "Hide relative-strength line" : "Show relative-strength line"}
              title={ratioOpen ? "Hide the stock / SPY ratio line" : "Show the stock / SPY ratio line"}
            >
              <AppIcon name={ratioOpen ? "chevU" : "chevD"} size={14} />
            </button>
          </div>
          {ratioOpen && (
            <div className="px-3.5 pb-3">
              <RatioVsSpxSparkline ticker={ticker} data={ratio} />
            </div>
          )}
        </div>
      )}

      {/* Analysis result */}
      {analysisError && (
        <div className="border-t border-line-soft bg-neg-soft px-3.5 py-2 text-[12.5px] text-neg">{analysisError}</div>
      )}
      {analysis && (
        <div className="border-t border-line-soft">
          <div className="flex flex-wrap items-center gap-2 px-3.5 py-1.5">
            <button
              type="button"
              onClick={() => setUiPref("stock.chartAnalysis.collapsed", chartAnalysisCollapsed ? "0" : "1")}
              className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ink hover:text-accent"
              aria-expanded={!chartAnalysisCollapsed}
              title={chartAnalysisCollapsed ? "Show the saved chart analysis" : "Hide the saved chart analysis"}
            >
              <AppIcon name={chartAnalysisCollapsed ? "chevR" : "chevD"} size={14} className="text-ink-3" />
              Chart analysis
            </button>
            {savedAnalysis?.outlook && (
              <span className={`inline-flex h-[18px] items-center rounded px-1.5 text-[11px] font-medium ${OUTLOOK_TONE[savedAnalysis.outlook] ?? "bg-surface-2 text-ink-2"}`}>
                {savedAnalysis.outlook}
              </span>
            )}
            <span className="text-[11.5px] text-ink-3">
              AI · {ticker} · {analysisRangeLabel} chart
              {savedAnalysis?.analyzedAt && (
                <> · {new Date(savedAnalysis.analyzedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</>
              )}
            </span>
            <button
              type="button"
              onClick={() => {
                if (!confirm("Clear this saved chart analysis? You can always regenerate it with the Analyze chart button.")) return;
                clearChartAnalysis(ticker);
              }}
              className="ml-auto inline-flex h-7 items-center gap-1 rounded-control border border-line bg-surface px-2 text-[12px] text-ink-3 hover:border-neg-border hover:bg-neg-soft hover:text-neg transition-colors"
              title="Delete this saved AI chart analysis (Redis-backed, syncs across devices)"
            >
              <AppIcon name="trash" size={12} /> Clear
            </button>
          </div>

          {!chartAnalysisCollapsed && (
            <div className="px-3.5 pb-3">
              {/* Structured summary — renders only when the saved analysis has
                  the new fields. Old analyses fall through to the prose block. */}
              {savedAnalysis?.outlook && (
                <div className="mb-3 rounded-control border border-line bg-surface-2 px-3 py-2.5">
                  <div className="mb-2 flex flex-wrap items-baseline gap-3">
                    <span className={`text-[13px] font-semibold ${
                      savedAnalysis.outlook === "Bullish" ? "text-pos" : savedAnalysis.outlook === "Bearish" ? "text-neg" : "text-ink-2"
                    }`}>
                      {savedAnalysis.outlook}
                    </span>
                    {typeof savedAnalysis.confidence === "number" && (
                      <span className="text-[11.5px] text-ink-3">Confidence <span className="font-mono">{Math.round(savedAnalysis.confidence * 100)}%</span></span>
                    )}
                    {savedAnalysis.nextAction && (
                      <span className="ml-auto text-[12.5px] text-ink-2">{savedAnalysis.nextAction}</span>
                    )}
                  </div>
                  <div className="mb-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                    {savedAnalysis.bullCase && (
                      <div className="rounded-control bg-pos-soft px-3 py-2">
                        <div className="mb-0.5 text-[11px] text-pos">Bull case</div>
                        <p className="text-[12.5px] leading-[1.5] text-ink-2">{savedAnalysis.bullCase}</p>
                      </div>
                    )}
                    {savedAnalysis.bearCase && (
                      <div className="rounded-control bg-neg-soft px-3 py-2">
                        <div className="mb-0.5 text-[11px] text-neg">Bear case</div>
                        <p className="text-[12.5px] leading-[1.5] text-ink-2">{savedAnalysis.bearCase}</p>
                      </div>
                    )}
                  </div>
                  {((savedAnalysis.support && savedAnalysis.support.length > 0) ||
                    (savedAnalysis.resistance && savedAnalysis.resistance.length > 0) ||
                    typeof savedAnalysis.stopBelow === "number") && (
                    <div className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
                      {savedAnalysis.support && savedAnalysis.support.length > 0 && (
                        <span><span className="text-ink-3">Support</span>{" "}
                          <span className="font-mono text-ink">{savedAnalysis.support.map((s) => s.toFixed(2)).join(", ")}</span>
                        </span>
                      )}
                      {savedAnalysis.resistance && savedAnalysis.resistance.length > 0 && (
                        <span><span className="text-ink-3">Resistance</span>{" "}
                          <span className="font-mono text-ink">{savedAnalysis.resistance.map((r) => r.toFixed(2)).join(", ")}</span>
                        </span>
                      )}
                      {typeof savedAnalysis.stopBelow === "number" && (
                        <span><span className="text-ink-3">Stop below</span>{" "}
                          <span className="font-mono text-ink">{savedAnalysis.stopBelow.toFixed(2)}</span>
                        </span>
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-0.5 text-[12.5px] leading-[1.5] text-ink-2">
                {analysis.split("\n").map((line, i) => {
                  // Skip horizontal rules and empty decorative lines
                  if (line.trim() === "---" || line.trim() === "***") return null;
                  // Section headers: **Bold Header** on its own line or ## / ###
                  if (/^#{1,3}\s/.test(line)) {
                    const text = line.replace(/^#{1,3}\s/, "").replace(/\*\*/g, "");
                    return <p key={i} className="mb-0.5 mt-2.5 font-medium text-ink">{text}</p>;
                  }
                  if (/^\*\*[^*]+\*\*\s*$/.test(line.trim())) {
                    return <p key={i} className="mb-0.5 mt-2.5 font-medium text-ink">{line.replace(/\*\*/g, "")}</p>;
                  }
                  // Bullet points
                  if (line.startsWith("- ") || line.startsWith("* ")) {
                    const content = line.slice(2).replace(/\*\*(.*?)\*\*/g, "$1");
                    return <p key={i} className="ml-3 border-l border-line pl-2 text-ink-2">{content}</p>;
                  }
                  // Table rows
                  if (line.includes("|") && line.trim().startsWith("|")) {
                    // Skip separator rows
                    if (/^\|[\s\-|]+\|$/.test(line.trim())) return null;
                    const cells = line.split("|").filter(c => c.trim()).map(c => c.trim());
                    if (cells.length === 0) return null;
                    return (
                      <div key={i} className="grid grid-cols-3 gap-2 py-0.5 font-mono text-[12px]">
                        {cells.map((cell, j) => (
                          <span key={j} className={j === 0 ? "font-medium text-ink-2" : "text-ink-3"}>{cell}</span>
                        ))}
                      </div>
                    );
                  }
                  // Empty lines — minimal spacing
                  if (line.trim() === "") return <div key={i} className="h-1" />;
                  // Regular text — inline bold handling
                  const parts = line.split(/(\*\*.*?\*\*)/g);
                  return (
                    <p key={i} className="text-ink-2">
                      {parts.map((part, j) =>
                        part.startsWith("**") && part.endsWith("**")
                          ? <span key={j} className="font-medium text-ink">{part.slice(2, -2)}</span>
                          : part
                      )}
                    </p>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
