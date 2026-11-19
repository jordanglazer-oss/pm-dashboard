"use client";

import { useEffect, useState } from "react";

/**
 * Daily benchmark series for the performance panels (Nov 2026): S&P 500
 * (US$), S&P 500 in C$, Nasdaq Composite and S&P/TSX, from
 * /api/index-history?extended=1. Having the SERIES (not pre-computed period
 * returns) is what lets a benchmark follow any date range the same way a
 * model does. Read-only; null until loaded, {} if the fetch failed.
 */

export type BenchKey = "sp500" | "sp500cad" | "nasdaq" | "tsx";
export type BenchPoint = { date: string; value: number };
export type BenchHistory = Partial<Record<BenchKey, BenchPoint[]>>;

export const BENCHMARKS: { key: BenchKey; label: string; note: string }[] = [
  { key: "sp500cad", label: "S&P 500 (C$)", note: "the alpha yardstick" },
  { key: "sp500", label: "S&P 500", note: "USD" },
  { key: "nasdaq", label: "Nasdaq", note: "USD" },
  { key: "tsx", label: "S&P/TSX", note: "CAD" },
];

export function useBenchmarkHistory(): BenchHistory | null {
  const [hist, setHist] = useState<BenchHistory | null>(null);
  useEffect(() => {
    let alive = true;
    fetch("/api/index-history?extended=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { indexes?: { key: string; history?: { date: string; close: number }[] }[] } | null) => {
        if (!alive) return;
        const out: BenchHistory = {};
        for (const ix of d?.indexes ?? []) {
          if (Array.isArray(ix.history) && ix.history.length > 1) out[ix.key as BenchKey] = ix.history.map((b) => ({ date: b.date, value: b.close }));
        }
        setHist(out);
      })
      .catch(() => alive && setHist({}));
    return () => {
      alive = false;
    };
  }, []);
  return hist;
}
