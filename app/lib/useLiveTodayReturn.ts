"use client";

/**
 * Single-source-of-truth hook for the "live today" return of a PIM
 * group/profile. The methodology mirrors PimPortfolio.todayReturn —
 * weighted by actual positions, USD positions translated to CAD with
 * the live USDCAD rate on the current side and yesterday's USDCAD on
 * the previous side so FX translation gain/loss becomes part of the
 * CAD return.
 *
 * ## Why this is a module-level cache, not a plain hook
 *
 * Multiple components (PimPortfolio for the Positioning tile,
 * PimPerformance for the chart's `effectiveHistory` overlay, PimModel
 * for the Sleeve Drift card AND the Dynamic Wt column on every
 * holdings row) ask for the same `(groupId, profile)` return. A naive
 * hook would create one independent React state slot per call — each
 * with its own fetch cycle, its own refetch — meaning the chart could
 * refresh from the Refresh button while Sleeve Drift sat on stale
 * prices, drifting away over the session.
 *
 * Instead, every call for the same key reads from one shared cache
 * entry. The first call to a key triggers the fetch; subsequent calls
 * subscribe to its value. ANY consumer calling refetch() refreshes the
 * value for ALL subscribers in a single network round-trip. This makes
 * the Positioning-page calculation the single canonical performance
 * figure that flows through to every consumer.
 *
 * Returns null until the computation completes, and stays null when
 * the market is closed (pre-market data is unreliable — Yahoo's
 * regularMarketPrice still reports yesterday's close before 9:30 AM
 * ET, which would label yesterday's return as today's).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { PimPortfolioPositions, PimProfileType, PimModelData } from "./pim-types";
import type { Stock } from "./types";
import { useStocks } from "./StockContext";
import { isMarketOpenOrAfterET } from "./market-hours";

export type UseLiveTodayReturnResult = {
  value: number | null;
  /** Re-fetch prices and recompute. Broadcasts to every subscriber. */
  refetch: () => void;
};

type Subscriber = (value: number | null) => void;

type CacheEntry = {
  value: number | null;
  /** True while a fetch is in flight — used to dedupe concurrent
   *  computeFor() calls from multiple components mounting in the same
   *  tick (only one network round-trip per key). */
  inFlight: boolean;
  subscribers: Set<Subscriber>;
};

// Module-level singleton. Survives the lifetime of the JS bundle — i.e.
// across route navigations within the same SPA session. Cleared by a
// hard reload, which matches the React state semantics we're replacing.
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

/** The actual compute logic — identical to the previous hook body,
 *  but writes into the cache and notifies subscribers instead of
 *  calling a single component's setState. */
async function computeFor(
  groupId: string,
  profile: PimProfileType,
  pimModels: PimModelData,
  stocks: Stock[],
): Promise<void> {
  const key = `${groupId}:${profile}`;
  const entry = getEntry(key);
  // Dedupe: if a fetch for this key is already in flight, skip — the
  // in-flight one will broadcast to every subscriber when it lands.
  if (entry.inFlight) return;

  // Pre-market data is unreliable — Yahoo's regularMarketPrice still
  // reports yesterday's close before 9:30 AM ET, which would label
  // yesterday's return as today's. Bail out and let the persisted
  // entry stand.
  if (!isMarketOpenOrAfterET()) return;
  const group = pimModels.groups.find((g) => g.id === groupId);
  if (!group) return;

  const isAlpha = profile === "alpha";
  const isCore = profile === "core";
  // Alpha + Core are both equity-only standalone models. Alpha
  // EXCLUDES core ETFs (everything-except-core); Core ONLY contains
  // core ETFs (inverse filter).
  const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const CORE_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
  const profileWeights = isAlpha
    ? ALPHA_WEIGHTS
    : isCore
    ? CORE_WEIGHTS
    : group.profiles[profile];
  if (!profileWeights) return;

  // Build the set of core-designated symbols for alpha/core filtering
  const coreSymbols = new Set<string>();
  for (const s of stocks) {
    if (s.designation === "core") coreSymbols.add(s.ticker);
  }

  entry.inFlight = true;
  try {
    // Load positions
    let positions: PimPortfolioPositions | null = null;
    try {
      const res = await fetch("/api/kv/pim-positions");
      if (res.ok) {
        const data = await res.json();
        const portfolios: PimPortfolioPositions[] = data.portfolios || [];
        positions =
          portfolios.find((p) => p.groupId === groupId && p.profile === profile) ||
          null;
      }
    } catch {
      /* ignore */
    }
    if (!positions || positions.positions.length === 0) return;

    const posMap = new Map(positions.positions.map((p) => [p.symbol, p]));

    // Filter active holdings by profile semantics:
    //   alpha → equity, EXCLUDE core symbols
    //   core  → equity, ONLY core symbols
    //   other → filter by >0% asset-class allocation
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

    const allSymbols = activeHoldings.map((h) => h.symbol);
    const tickers = allSymbols.map((s) => {
      if (s.endsWith("-T")) return s.replace("-T", ".TO");
      if (s.endsWith(".U")) return s.replace(".U", "-U.TO");
      return s;
    });

    const [priceRes, fxRes] = await Promise.all([
      fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers }),
      }),
      fetch("/api/prices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tickers: ["USDCAD=X"] }),
      }),
    ]);

    if (!priceRes.ok) return;
    const priceData = await priceRes.json();

    // Pull BOTH today's live USDCAD and its previous close. We apply the
    // previous-close rate to the prev side of the return ratio and the
    // live rate to the current side so FX translation gain/loss becomes
    // part of the CAD return — matching the methodology in
    // /api/update-daily-value, which is what the Appendix ledger stores.
    // Using the same rate on both sides (the prior behaviour) cancelled
    // out FX movement entirely, which caused the Performance Tracker's
    // "Today" number to diverge from the Appendix's daily return.
    let usdCadCurrRate = 1;
    let usdCadPrevRate = 1;
    if (fxRes.ok) {
      const fxData = await fxRes.json();
      const rate = fxData.prices?.["USDCAD=X"];
      const prevRate = fxData.previousCloses?.["USDCAD=X"];
      if (rate && rate > 0) usdCadCurrRate = rate;
      // Fall back to live rate if previousClose is missing, so CAD-only
      // portfolios keep working and USD portfolios degrade gracefully
      // to the old (FX-cancelled) behaviour rather than NaN-ing out.
      usdCadPrevRate = prevRate && prevRate > 0 ? prevRate : usdCadCurrRate;
    }

    // Identical to PimPortfolio.todayReturn
    let prevTotalCad = 0;
    let currTotalCad = 0;
    for (const h of activeHoldings) {
      const pos = posMap.get(h.symbol);
      if (!pos || pos.units <= 0) continue;

      let yahoo = h.symbol;
      if (h.symbol.endsWith("-T")) yahoo = h.symbol.replace("-T", ".TO");
      else if (h.symbol.endsWith(".U")) yahoo = h.symbol.replace(".U", "-U.TO");

      const currentPrice = priceData.prices?.[yahoo] ?? priceData.prices?.[h.symbol];
      const prevClose =
        priceData.previousCloses?.[yahoo] ?? priceData.previousCloses?.[h.symbol];

      if (prevClose == null || prevClose <= 0 || currentPrice == null) continue;

      const prevFx = h.currency === "USD" ? usdCadPrevRate : 1;
      const currFx = h.currency === "USD" ? usdCadCurrRate : 1;
      prevTotalCad += pos.units * prevClose * prevFx;
      currTotalCad += pos.units * currentPrice * currFx;
    }

    if (prevTotalCad > 0) {
      entry.value = ((currTotalCad - prevTotalCad) / prevTotalCad) * 100;
      broadcast(entry);
    }
  } catch {
    /* ignore */
  } finally {
    entry.inFlight = false;
  }
}

export function useLiveTodayReturn(
  groupId: string,
  profile: PimProfileType,
): UseLiveTodayReturnResult {
  const { pimModels, stocks } = useStocks();
  const key = `${groupId}:${profile}`;

  // Local state mirrors the cache entry's value so React re-renders
  // when the cache updates. The setState reference becomes the
  // subscriber registered against the cache entry.
  const [value, setValue] = useState<number | null>(() => getEntry(key).value);

  // Stable refs for pimModels / stocks so refetch() doesn't change
  // identity every render — that would defeat downstream useCallback
  // dep arrays that depend on it.
  const pimModelsRef = useRef(pimModels);
  const stocksRef = useRef(stocks);
  useEffect(() => { pimModelsRef.current = pimModels; }, [pimModels]);
  useEffect(() => { stocksRef.current = stocks; }, [stocks]);

  // Subscribe / unsubscribe on (key) change.
  useEffect(() => {
    const entry = getEntry(key);
    entry.subscribers.add(setValue);
    // Sync to current cache value on (re)subscribe — covers the case
    // where a value was already computed by a sibling before we
    // mounted, and the case where the key changed (different cache
    // entry, possibly with its own pre-computed value).
    setValue(entry.value);
    return () => {
      entry.subscribers.delete(setValue);
    };
  }, [key]);

  // Trigger the first compute for this key (the inFlight flag inside
  // computeFor dedupes if multiple components mount simultaneously,
  // so only one network call lands per key).
  useEffect(() => {
    computeFor(groupId, profile, pimModelsRef.current, stocksRef.current);
    // The deps for pimModels/stocks intentionally re-trigger compute:
    // when StockContext updates positions/holdings, every subscriber
    // gets a fresh value via the single shared fetch.
  }, [groupId, profile, pimModels, stocks]);

  const refetch = useCallback(() => {
    computeFor(groupId, profile, pimModelsRef.current, stocksRef.current);
  }, [groupId, profile]);

  return { value, refetch };
}
