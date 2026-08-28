"use client";

import React from "react";

/**
 * StatStrip — the streamline redesign's replacement for grids of small
 * rounded stat tiles ("a card per number"). Renders label-over-value cells
 * separated by hairlines inside ONE bordered container: same data, a
 * quarter of the ink. The -ml-px/-mt-px + overflow-hidden trick collapses
 * duplicate borders at the container edge, so wrapped rows stay clean.
 */
export function StatStrip({
  items,
  cols = 4,
  className,
}: {
  items: { label: React.ReactNode; value: React.ReactNode; title?: string }[];
  /** Column count at ≥sm. Below sm everything falls back to 2-up. */
  cols?: 2 | 3 | 4 | 5 | 6 | 7 | 8;
  className?: string;
}) {
  if (items.length === 0) return null;
  const colCls =
    cols === 2 ? "grid-cols-2"
    : cols === 3 ? "grid-cols-2 sm:grid-cols-3"
    : cols === 4 ? "grid-cols-2 sm:grid-cols-4"
    : cols === 5 ? "grid-cols-2 sm:grid-cols-5"
    : cols === 6 ? "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
    : cols === 7 ? "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7"
    : "grid-cols-2 sm:grid-cols-4 lg:grid-cols-8";
  return (
    <div className={`grid ${colCls} overflow-hidden rounded-card border border-line-soft bg-white ${className || ""}`}>
      {items.map((it, i) => (
        <div key={i} className="-ml-px -mt-px min-w-0 border-l border-t border-line-soft px-3 py-2" title={it.title}>
          <div className="truncate text-[10px] font-semibold uppercase tracking-wider text-ink-3">{it.label}</div>
          <div className="mt-0.5 truncate text-sm font-semibold text-ink tabular-nums">{it.value}</div>
        </div>
      ))}
    </div>
  );
}
