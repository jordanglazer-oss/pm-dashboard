"use client";

/**
 * Live CURRENT model weight per holding (canonicalTicker → % of portfolio),
 * for a PIM group + profile. Same methodology as PimPortfolio.currentPct
 * (market value in CAD ÷ total portfolio value incl. cash), so the Rankings
 * "Weight" column matches the Positioning tab exactly.
 *
 * Module-level cache keyed by `${groupId}:${profile}` — mirrors
 * useLiveTodayReturn: the first consumer triggers one fetch, later consumers
 * subscribe, and refetch() refreshes every subscriber in one round-trip. Unlike
 * the return hook there is NO market-hours gate — a current-weight snapshot is
 * valid any time prices are available.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PimPortfolioPositions, PimProfileType, PimModelData } from "./pim-types";
import type { Stock } from "./types";
import { useStocks } from "./StockContext";
import { canonicalTicker } from "./ticker";

export type WeightMap = Map<string, number>; // canonicalTicker → weight %

type Subscriber = (value: WeightMap | null) => void;
type CacheEntry = { value: WeightMap | null; inFlight: boolean; subscribers: Set<Subscriber> };

const cache = new Map<string, CacheEntry>();

function getEntry(key: string): CacheEntry {
  let entry = cache.get(key);
  if (!entry) {
    entry = { value: null, inFlight: false, subscribers: new Set() };
    cache.set(key, entry);
  }
  return entry;
}

function broadcast(entry: CacheEntry) {
  for (const sub of entry.subscribers) sub(entry.value);
}

function yahooForm(symbol: string): string {
  if (symbol.endsWith("-T")) return symbol.replace("-T", ".TO");
  if (symbol.endsWith(".U")) return symbol.replace(".U", "-U.TO");
  return symbol;
}

async function computeWeightsFor(
  groupId: string,
  profile: PimProfileType,
  pimModels: PimModelData,
  stocks: Stock[],
): Promise<void> {
  const key = `${groupId}:${profile}`;
  const entry = getEntry(key);
  if (entry.inFlight) return;

  const group = pimModels.groups.find((g) => g.id === groupId);
  if (!group) return;

  const isAlpha = profile === "alpha";
  const isCore = profile === "core";
  const EQUITY_ONLY = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const profileWeights = isAlpha || isCore ? EQUITY_ONLY : group.profiles[profile];
  if (!profileWeights) return;

  const coreSymbols = new Set<string>();
  for (const s of stocks) if (s.designation === "core") coreSymbols.add(s.ticker);

  entry.inFlight = true;
  try {
    let positions: PimPortfolioPositions | null = null;
    try {
      const res = await fetch("/api/kv/pim-positions");
      if (res.ok) {
        const data = await res.json();
        const portfolios: PimPortfolioPositions[] = data.portfolios || [];
        positions = portfolios.find((p) => p.groupId === groupId && p.profile === profile) || null;
      }
    } catch { /* ignore */ }
    if (!positions || positions.positions.length === 0) return;

    const posMap = new Map(positions.positions.map((p) => [p.symbol, p]));

    let activeHoldings;
    if (isAlpha || isCore) {
      activeHoldings = group.holdings.filter((h) => {
        if (h.assetClass !== "equity") return false;
        const tk = h.symbol.endsWith("-T") ? h.symbol.replace(/-T$/, ".TO") : h.symbol;
        const isCoreSym = coreSymbols.has(tk);
        return isAlpha ? !isCoreSym : isCoreSym;
      });
    } else {
      activeHoldings = group.holdings.filter((h) => {
        let assetAlloc = 0;
        if (h.assetClass === "fixedIncome") assetAlloc = profileWeights.fixedIncome;
        else if (h.assetClass === "equity") assetAlloc = profileWeights.equity;
        else if (h.assetClass === "alternative") assetAlloc = profileWeights.alternatives;
        return h.weightInClass * assetAlloc > 0;
      });
    }

    const tickers = activeHoldings.map((h) => yahooForm(h.symbol));
    const [priceRes, fxRes] = await Promise.all([
      fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers }) }),
      fetch("/api/prices", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tickers: ["USDCAD=X"] }) }),
    ]);
    if (!priceRes.ok) return;
    const priceData = await priceRes.json();

    let usdCad = 1;
    if (fxRes.ok) {
      const fxData = await fxRes.json();
      const rate = fxData.prices?.["USDCAD=X"];
      if (rate && rate > 0) usdCad = rate;
    }

    // Denominator matches PimPortfolio's totalValueCad = cash + every holding's CAD value.
    let totalCad = positions.cashBalance || 0;
    const valueByTicker = new Map<string, number>();
    for (const h of activeHoldings) {
      const pos = posMap.get(h.symbol);
      if (!pos || pos.units <= 0) continue;
      const yahoo = yahooForm(h.symbol);
      const price = priceData.prices?.[yahoo] ?? priceData.prices?.[h.symbol];
      if (price == null || price <= 0) continue;
      const fx = h.currency === "USD" ? usdCad : 1;
      const valueCad = pos.units * price * fx;
      valueByTicker.set(canonicalTicker(h.symbol), (valueByTicker.get(canonicalTicker(h.symbol)) || 0) + valueCad);
      totalCad += valueCad;
    }

    const weights: WeightMap = new Map();
    if (totalCad > 0) {
      for (const [tk, v] of valueByTicker) weights.set(tk, (v / totalCad) * 100);
    }
    entry.value = weights;
    broadcast(entry);
  } catch {
    /* ignore */
  } finally {
    entry.inFlight = false;
  }
}

export function useLiveModelWeights(groupId: string, profile: PimProfileType): {
  weights: WeightMap | null;
  refetch: () => void;
} {
  const { pimModels, stocks } = useStocks();
  const key = `${groupId}:${profile}`;
  const [value, setValue] = useState<WeightMap | null>(() => getEntry(key).value);

  const pimModelsRef = useRef(pimModels);
  const stocksRef = useRef(stocks);
  useEffect(() => { pimModelsRef.current = pimModels; }, [pimModels]);
  useEffect(() => { stocksRef.current = stocks; }, [stocks]);

  useEffect(() => {
    const entry = getEntry(key);
    entry.subscribers.add(setValue);
    setValue(entry.value);
    return () => { entry.subscribers.delete(setValue); };
  }, [key]);

  useEffect(() => {
    computeWeightsFor(groupId, profile, pimModelsRef.current, stocksRef.current);
  }, [groupId, profile, pimModels, stocks]);

  const refetch = useCallback(() => {
    computeWeightsFor(groupId, profile, pimModelsRef.current, stocksRef.current);
  }, [groupId, profile]);

  return { weights: value, refetch };
}
