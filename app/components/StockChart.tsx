"use client";

import React, { useRef, useEffect, useState, useCallback } from "react";
import type { TechnicalIndicators } from "@/app/lib/technicals";
import { useStocks } from "@/app/lib/StockContext";

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
};

export default function StockChart({ ticker, technicals, className = "" }: Props) {
  const { chartAnalyses, setChartAnalysis, clearChartAnalysis } = useStocks();
  const containerRef = useRef<HTMLDivElement>(null);
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
        height: 420,
        layout: {
          background: { color: "#ffffff" },
          textColor: "#64748b",
          fontFamily: "ui-monospace, monospace",
          fontSize: 11,
        },
        grid: {
          vertLines: { color: "#f1f5f9" },
          horzLines: { color: "#f1f5f9" },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: "#94a3b8", width: 1, style: lc.LineStyle.Dashed },
          horzLine: { color: "#94a3b8", width: 1, style: lc.LineStyle.Dashed },
        },
        rightPriceScale: {
          borderColor: "#e2e8f0",
        },
        timeScale: {
          borderColor: "#e2e8f0",
          timeVisible: false,
        },
      });

      chartRef.current = chart;

      // Candlestick series
      const candleSeries = chart.addSeries(lc.CandlestickSeries, {
        upColor: "#10b981",
        downColor: "#ef4444",
        borderUpColor: "#10b981",
        borderDownColor: "#ef4444",
        wickUpColor: "#10b981",
        wickDownColor: "#ef4444",
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
          color: b.close >= b.open ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)",
        }))
      );

      // SMA 50 overlay (blue)
      if (chartData.sma50.length > 0) {
        const sma50Series = chart.addSeries(lc.LineSeries, {
          color: "#3b82f6",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        sma50Series.setData(
          chartData.sma50.map((p) => ({ time: p.date, value: p.value }))
        );
      }

      // SMA 200 overlay (red)
      if (chartData.sma200.length > 0) {
        const sma200Series = chart.addSeries(lc.LineSeries, {
          color: "#ef4444",
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: false,
          crosshairMarkerVisible: false,
        });
        sma200Series.setData(
          chartData.sma200.map((p) => ({ time: p.date, value: p.value }))
        );
      }

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

      // Resize observer
      const ro = new ResizeObserver((entries) => {
        for (const entry of entries) {
          chart.applyOptions({ width: entry.contentRect.width });
        }
      });
      ro.observe(containerRef.current);

      const currentContainer = containerRef.current;
      return () => {
        ro.unobserve(currentContainer);
        ro.disconnect();
      };
    })();

    return () => {
      disposed = true;
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

  return (
    <div className={className}>
      <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-sm">
        {/* Header row */}
        <div className="flex flex-col gap-2 mb-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-bold text-slate-800">Price Chart</h2>
              <div className="hidden sm:flex items-center gap-3 text-xs text-slate-400">
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-0.5 bg-blue-500 rounded" /> SMA 50
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block w-3 h-0.5 bg-red-500 rounded" /> SMA 200
                </span>
              </div>
            </div>
            {totalBars > 0 && (
              <span className="text-[10px] text-slate-400">{yearsOfData}+ yrs &middot; scroll to explore</span>
            )}
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Timeframe selector — zoom only, no re-fetch */}
            <div className="flex rounded-xl border border-slate-200 overflow-hidden">
              {RANGES.map((r) => (
                <button
                  key={r.key}
                  onClick={() => setViewRange(r.key)}
                  className={`px-2 py-1.5 text-[11px] font-semibold transition-colors ${
                    viewRange === r.key
                      ? "bg-slate-900 text-white"
                      : "text-slate-500 hover:bg-slate-50"
                  }`}
                >
                  {r.label}
                </button>
              ))}
            </div>

            {/* Analyze button */}
            <button
              onClick={handleAnalyze}
              disabled={analyzing || loading || !chartData}
              className="rounded-xl bg-violet-600 px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-violet-700 transition-colors disabled:opacity-50 flex items-center gap-1.5"
            >
              {analyzing && (
                <span className="inline-block w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />
              )}
              {analyzing ? "Analyzing..." : "Analyze Chart"}
            </button>

            {/* SMA legend on mobile */}
            <div className="flex sm:hidden items-center gap-2 text-[10px] text-slate-400 ml-auto">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-0.5 bg-blue-500 rounded" /> 50
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-0.5 bg-red-500 rounded" /> 200
              </span>
            </div>
          </div>
        </div>

        {/* Chart container */}
        {loading && (
          <div className="flex items-center justify-center h-[420px] text-slate-400">
            <span className="inline-block w-5 h-5 border-2 border-slate-300 border-t-transparent rounded-full animate-spin mr-2" />
            Loading chart data...
          </div>
        )}
        {error && (
          <div className="flex items-center justify-center h-[420px] text-red-500 text-sm">
            {error}
          </div>
        )}
        <div
          ref={containerRef}
          className={`w-full ${loading || error ? "hidden" : ""}`}
          style={{ minHeight: 420 }}
        />
      </div>

      {/* Analysis result */}
      {analysisError && (
        <div className="mt-4 rounded-[24px] border border-red-200 bg-red-50 p-5 shadow-sm">
          <p className="text-sm text-red-600">{analysisError}</p>
        </div>
      )}
      {analysis && (
        <div className="mt-4 rounded-[24px] border border-violet-200 bg-white p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-3">
            <h3 className="text-base font-bold text-slate-800">Chart Analysis</h3>
            <span className="rounded-full bg-violet-100 text-violet-700 px-2 py-0.5 text-[10px] font-semibold">
              AI Generated
            </span>
            <span className="text-xs text-slate-400 ml-auto">
              {ticker} &middot; {savedAnalysis?.range ? RANGES.find((r) => r.key === savedAnalysis.range)?.label || savedAnalysis.range : RANGES.find((r) => r.key === viewRange)?.label} chart
              {savedAnalysis?.analyzedAt && (
                <> &middot; {new Date(savedAnalysis.analyzedAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true })}</>
              )}
            </span>
            <button
              onClick={() => {
                if (!confirm("Clear this saved chart analysis? You can always regenerate it with the Analyze Chart button.")) return;
                clearChartAnalysis(ticker);
              }}
              className="rounded-md border border-slate-200 bg-white px-2 py-1 text-[11px] font-semibold text-slate-500 hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-colors"
              title="Delete this saved AI chart analysis (Redis-backed, syncs across devices)"
            >
              Clear
            </button>
          </div>
          <div className="text-sm leading-relaxed text-slate-600 space-y-0.5">
            {analysis.split("\n").map((line, i) => {
              // Skip horizontal rules and empty decorative lines
              if (line.trim() === "---" || line.trim() === "***") return null;
              // Section headers: **Bold Header** on its own line or ## / ###
              if (/^#{1,3}\s/.test(line)) {
                const text = line.replace(/^#{1,3}\s/, "").replace(/\*\*/g, "");
                return <p key={i} className="font-semibold text-slate-800 mt-3 mb-0.5 text-sm">{text}</p>;
              }
              if (/^\*\*[^*]+\*\*\s*$/.test(line.trim())) {
                return <p key={i} className="font-semibold text-slate-800 mt-3 mb-0.5 text-sm">{line.replace(/\*\*/g, "")}</p>;
              }
              // Bullet points
              if (line.startsWith("- ") || line.startsWith("* ")) {
                const content = line.slice(2).replace(/\*\*(.*?)\*\*/g, "$1");
                return <p key={i} className="ml-3 text-slate-600 pl-2 border-l-2 border-slate-200">{content}</p>;
              }
              // Table rows
              if (line.includes("|") && line.trim().startsWith("|")) {
                // Skip separator rows
                if (/^\|[\s\-|]+\|$/.test(line.trim())) return null;
                const cells = line.split("|").filter(c => c.trim()).map(c => c.trim());
                if (cells.length === 0) return null;
                return (
                  <div key={i} className="grid grid-cols-3 gap-2 text-xs py-0.5 font-mono">
                    {cells.map((cell, j) => (
                      <span key={j} className={j === 0 ? "text-slate-700 font-medium" : "text-slate-500"}>{cell}</span>
                    ))}
                  </div>
                );
              }
              // Empty lines — minimal spacing
              if (line.trim() === "") return <div key={i} className="h-1" />;
              // Regular text — inline bold handling
              const parts = line.split(/(\*\*.*?\*\*)/g);
              return (
                <p key={i} className="text-slate-600">
                  {parts.map((part, j) =>
                    part.startsWith("**") && part.endsWith("**")
                      ? <span key={j} className="font-medium text-slate-800">{part.slice(2, -2)}</span>
                      : part
                  )}
                </p>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
