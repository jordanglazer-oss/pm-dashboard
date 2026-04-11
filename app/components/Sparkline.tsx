"use client";

import React from "react";

type SparkPoint = { date: string; value: number };

type Props = {
  points: SparkPoint[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  // Optional explicit y-axis bounds. If unset, we use [min, max] from the
  // data with a 5% padding so flat-ish series still show shape.
  yMin?: number;
  yMax?: number;
  // Optional reference line (e.g. zero for an oscillator).
  referenceY?: number;
  // Show the most recent value as a dot at the right edge.
  showLastDot?: boolean;
  className?: string;
};

// Tiny inline SVG sparkline. No external deps. Designed to live inside the
// existing sentiment tiles without taking over the layout — defaults to a
// 140×40 strip that fits under the headline number.
export function Sparkline({
  points,
  width = 140,
  height = 40,
  stroke = "#3b82f6",
  fill = "rgba(59, 130, 246, 0.12)",
  yMin,
  yMax,
  referenceY,
  showLastDot = true,
  className,
}: Props) {
  if (!points || points.length < 2) {
    return (
      <div
        className={`flex items-center justify-center text-[10px] text-slate-300 ${
          className ?? ""
        }`}
        style={{ width, height }}
      >
        building history…
      </div>
    );
  }

  const values = points.map((p) => p.value);
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  const lo = yMin != null ? yMin : dataMin;
  const hi = yMax != null ? yMax : dataMax;
  // Pad so a perfectly flat line still has visible thickness inside the box.
  const span = Math.max(hi - lo, 0.01);
  const pad = span * 0.08;
  const yLo = lo - pad;
  const yHi = hi + pad;
  const ySpan = yHi - yLo;

  const xStep = points.length > 1 ? width / (points.length - 1) : 0;
  const toX = (i: number) => i * xStep;
  const toY = (v: number) => height - ((v - yLo) / ySpan) * height;

  const linePath = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${toX(i).toFixed(2)},${toY(p.value).toFixed(2)}`)
    .join(" ");
  const areaPath = `${linePath} L${toX(points.length - 1).toFixed(
    2
  )},${height} L0,${height} Z`;

  const refLineY = referenceY != null ? toY(referenceY) : null;

  const last = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role="img"
      aria-label={`Sparkline of ${points.length} values, latest ${last.value}`}
    >
      {refLineY != null && (
        <line
          x1={0}
          y1={refLineY}
          x2={width}
          y2={refLineY}
          stroke="#cbd5e1"
          strokeWidth={1}
          strokeDasharray="2 2"
        />
      )}
      <path d={areaPath} fill={fill} stroke="none" />
      <path
        d={linePath}
        fill="none"
        stroke={stroke}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {showLastDot && (
        <circle
          cx={toX(points.length - 1)}
          cy={toY(last.value)}
          r={2.2}
          fill={stroke}
        />
      )}
    </svg>
  );
}
