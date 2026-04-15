"use client";

/**
 * Shared hook that computes the "live today" return for a given PIM
 * group/profile by fetching current prices and comparing against the
 * previous close. Used by both PimPerformance.tsx and the AA & Perf
 * page so the two screens display identical numbers.
 *
 * Returns null until the computation is complete or when the market
 * is closed (pre-market data is unreliable — Yahoo's regularMarketPrice
 * still reports yesterday's close before 9:30 AM ET, which would label
 * yesterday's return as today's).
 *
 * The methodology mirrors PimPortfolio.todayReturn: weighted by the
 * portfolio's actual positions (when available), with USD positions
 * converted to CAD via the live USDCAD rate.
 */

import { useCallback, useEffect, useState } from "react";
import type { PimPortfolioPositions, PimProfileType } from "./pim-types";
import { useStocks } from "./StockContext";
import { isMarketOpenOrAfterET } from "./market-hours";

export type UseLiveTodayReturnResult = {
  value: number | null;
  /** Re-fetch prices and recompute. Useful after a manual refresh. */
  refetch: () => void;
};

export function useLiveTodayReturn(
  groupId: string,
  profile: PimProfileType
): UseLiveTodayReturnResult {
  const { pimModels, stocks } = useStocks();
  const [liveTodayReturn, setLiveTodayReturn] = useState<number | null>(null);

  const compute = useCallback(async () => {
    // Pre-market data is unreliable — Yahoo's regularMarketPrice still
    // reports yesterday's close before 9:30 AM ET, which would label
    // yesterday's return as today's. Bail out and let the persisted
    // entry stand.
    if (!isMarketOpenOrAfterET()) return;
    const group = pimModels.groups.find((g) => g.id === groupId);
    if (!group) return;

    const isAlpha = profile === "alpha";
    // Alpha is equity-only, excluding core ETFs.
    const ALPHA_WEIGHTS = { cash: 0, fixedIncome: 0, equity: 1, alternatives: 0 };
    const profileWeights = isAlpha ? ALPHA_WEIGHTS : group.profiles[profile];
    if (!profileWeights) return;

    // Build the set of core-designated symbols for alpha filtering
    const coreSymbols = new Set<string>();
    for (const s of stocks) {
      if (s.designation === "core") coreSymbols.add(s.ticker);
    }

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

    // For alpha: equity-only, exclude core ETFs; otherwise filter by >0% model weight
    let activeHoldings;
    if (isAlpha) {
      activeHoldings = group.holdings.filter(
        (h) =>
          h.assetClass === "equity" &&
          !coreSymbols.has(h.symbol.endsWith("-T") ? h.symbol.replace(/-T$/, ".TO") : h.symbol)
      );
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

    try {
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
        setLiveTodayReturn(((currTotalCad - prevTotalCad) / prevTotalCad) * 100);
      }
    } catch {
      /* ignore */
    }
  }, [groupId, profile, pimModels, stocks]);

  useEffect(() => {
    // compute() is async — every setState inside it happens after at
    // least one `await`, so it can't trigger a synchronous cascading
    // render. The lint rule is a false positive here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    compute();
  }, [compute]);

  return { value: liveTodayReturn, refetch: compute };
}
