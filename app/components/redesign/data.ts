"use client";

/**
 * Read-only data hooks for the redesign pages. Every hook reads an EXISTING
 * route; none of them writes. Failures resolve to null so a page shows
 * "not available" instead of breaking.
 */

import { useEffect, useMemo, useState } from "react";
import type { ForwardLookingBundle } from "@/app/lib/types";
import type { MarketRegimeData } from "@/app/lib/market-regime";
import type { DailySummary } from "@/app/lib/daily-summary";
import type { PimPerformanceData } from "@/app/lib/pim-types";
import { useStocks } from "@/app/lib/StockContext";
import { buildFacts, type Fact } from "./facts";

type State<T> = { data: T | null; loading: boolean };

export function useGet<T>(url: string | null, pick?: (raw: unknown) => T | null): State<T> {
  const [state, setState] = useState<State<T>>({ data: null, loading: Boolean(url) });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    fetch(url, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((raw) => {
        if (!alive) return;
        setState({ data: raw == null ? null : pick ? pick(raw) : (raw as T), loading: false });
      })
      .catch(() => alive && setState({ data: null, loading: false }));
    return () => {
      alive = false;
    };
    // `pick` is a stable inline projector at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  return state;
}

const pickRegime = (raw: unknown) => (raw as { regime?: MarketRegimeData | null })?.regime ?? null;
const pickForward = (raw: unknown) => ((raw as { error?: string })?.error ? null : (raw as ForwardLookingBundle));

/** The market facts (no labels, no votes). */
export function useFacts(): { facts: Fact[]; loading: boolean; fetchedAt: string | null } {
  const fwd = useGet<ForwardLookingBundle>("/api/forward-looking", pickForward);
  const reg = useGet<MarketRegimeData>("/api/market-regime", pickRegime);
  const { marketData } = useStocks();
  const facts = useMemo(() => buildFacts(fwd.data, reg.data, marketData), [fwd.data, reg.data, marketData]);
  return { facts, loading: fwd.loading || reg.loading, fetchedAt: fwd.data?.fetchedAt ?? reg.data?.computedAt ?? null };
}

export function useSummary(): State<DailySummary> {
  return useGet<DailySummary>("/api/daily-summary");
}

export function usePerformance(): State<PimPerformanceData> {
  return useGet<PimPerformanceData>("/api/kv/pim-performance", (raw) => (Array.isArray((raw as PimPerformanceData)?.models) ? (raw as PimPerformanceData) : null));
}

/** Latest prices for a list of tickers (the existing /api/prices POST). */
export function usePrices(tickers: string[]): { prices: Record<string, number | null>; at: string | null } {
  const key = tickers.join(",");
  const [state, setState] = useState<{ prices: Record<string, number | null>; at: string | null }>({ prices: {}, at: null });
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const load = () =>
      fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: key.split(",") }) })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (alive && d?.prices) setState({ prices: d.prices, at: new Date().toISOString() });
        })
        .catch(() => {});
    load();
    const id = setInterval(load, 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [key]);
  return state;
}
