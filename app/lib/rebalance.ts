/* ─── PIM rebalance math (pure) ───
 *
 * Moved verbatim out of StockContext's rebalanceStockWeights so the money
 * math can be unit-tested (tests/rebalance.test.ts). StockContext calls this
 * with its live `stocks`, `pimBaseline` and `!sleeveTargetsRef.current`, so
 * behaviour is unchanged. No React, no Redis. */

import type { Stock } from "./types";
import type { PimHolding, PimModelGroup } from "./pim-types";

// Legacy lock list — kept ONLY as a fallback for holdings that have no
// corresponding entry in pm:stocks (and therefore no `designation` field).
// The primary lock mechanism is per-stock `designation` in pm:stocks.
export const LEGACY_LOCKED_EQUITY_SYMBOLS = new Set(["FID5982", "FID5982-T", "GRNJ"]);

/** Same rule as StockContext's isStock helper. */
const isStock = (s: Stock | { instrumentType?: string }) => !s.instrumentType || s.instrumentType === "stock";

/** The legacy -T / .TO ticker match StockContext exposes as `tickerMatch`. */
export function tickerMatch(a: string, b: string): boolean {
  return a === b || a.replace("-T", ".TO") === b.replace("-T", ".TO");
}

export type RebalanceContext = {
  /** pm:stocks (book). */
  stocks: Stock[];
  /** PIM baseline groups (pm:pim-model-baseline, seed fallback). */
  pimBaseline: PimModelGroup[];
  /** A stock being added that may not be in `stocks` yet. */
  extraStock?: Stock;
  /** True when the models carry NO sleeveTargets (pre-three-bucket rule). */
  useSeedRatios: boolean;
};

/** Individual stocks keep a fixed weight, locked/pinned holdings pass through,
 *  Core ETFs absorb the residual. */
export function rebalanceHoldings(holdings: PimHolding[], ctx: RebalanceContext): PimHolding[] {
  const { stocks, pimBaseline, extraStock, useSeedRatios } = ctx;
  // Reference per-stock weight from PIM base model (Redis-backed baseline, seed fallback)
  const pimBaseGroup = pimBaseline.find((g) => g.id === "pim");
  const refPerStock = 0.018182; // PIM baseline default for individual stocks

  // Build a set of individual stock symbols from the PIM base model seed
  // Stocks are equity holdings with weightInClass === refPerStock (the fixed per-stock weight)
  const seedStockSymbols = new Set<string>();
  if (pimBaseGroup) {
    for (const h of pimBaseGroup.holdings) {
      if (h.assetClass === "equity" && Math.abs(h.weightInClass - refPerStock) < 0.001) {
        seedStockSymbols.add(h.symbol);
        seedStockSymbols.add(h.symbol.replace(/-T$/, ".TO"));
        seedStockSymbols.add(h.symbol.replace(/\.TO$/, "-T"));
      }
    }
  }
  // Also include any portfolio stocks added after seed
  for (const s of stocks) {
    if (s.bucket === "Portfolio" && isStock(s)) {
      seedStockSymbols.add(s.ticker);
      seedStockSymbols.add(s.ticker.replace(".TO", "-T"));
      seedStockSymbols.add(s.ticker.replace("-T", ".TO"));
    }
  }
  if (extraStock && isStock(extraStock)) {
    seedStockSymbols.add(extraStock.ticker);
    seedStockSymbols.add(extraStock.ticker.replace(".TO", "-T"));
    seedStockSymbols.add(extraStock.ticker.replace("-T", ".TO"));
  }

  // Determine whether an equity ETF/MF holding should be Alpha-locked (weight
  // preserved through rebalance) vs Core (absorbs residual). The PRIMARY
  // mechanism is the per-stock `designation` field in pm:stocks, set by the
  // user via the Role toggle in the Stocks tab. Default-undefined designation
  // is treated as Alpha — this matches both the UI default (PortfolioOverview
  // renders `(s.designation || "alpha") === "core"`) and types.ts which
  // documents the field as "default alpha". Only an EXPLICIT "core" tag
  // makes a holding residual-absorbing.
  //
  // Behavior decision tree:
  //   - pm:stocks entry has designation === "core"   → NOT locked (Core ETF)
  //   - pm:stocks entry exists, any other state      → Alpha-locked
  //   - no pm:stocks entry at all (rare/stale data)  → legacy fallback
  const isAlphaLockedHolding = (symbol: string): boolean => {
    const stockEntry = stocks.find((s) =>
      s.ticker === symbol ||
      s.ticker.replace(/\.TO$/, "-T") === symbol ||
      s.ticker.replace(/-T$/, ".TO") === symbol,
    );
    if (stockEntry) {
      // Any tagged-or-untagged pm:stocks entry locks UNLESS explicitly "core"
      return stockEntry.designation !== "core";
    }
    // No pm:stocks entry at all → legacy fallback
    return LEGACY_LOCKED_EQUITY_SYMBOLS.has(symbol);
  };

  const equityHoldings = holdings.filter((h) => h.assetClass === "equity");
  const nonEquity = holdings.filter((h) => h.assetClass !== "equity");

  // Split equity holdings into three pools:
  //   1) individual stocks — locked at refPerStock
  //   2) Alpha-tagged funds — pass-through, keep current weightInClass
  //   3) Core-tagged ETFs — absorb residual equity weight proportionally
  // A PINNED stock (weight set in a Review commit) is skipped by the rule —
  // it holds its pinned weight like a hand-set fund until the pin is released.
  const isPinned = (h: PimHolding) => h.pinned != null && Number.isFinite(h.pinned.weightInClass);
  const stockHoldings = equityHoldings.filter((h) => seedStockSymbols.has(h.symbol) && !isPinned(h));
  const lockedHoldings = equityHoldings.filter(
    (h) => (seedStockSymbols.has(h.symbol) && isPinned(h)) || (!seedStockSymbols.has(h.symbol) && isAlphaLockedHolding(h.symbol)),
  ).map((h) => (isPinned(h) ? { ...h, weightInClass: h.pinned!.weightInClass } : h));
  const etfHoldings = equityHoldings.filter(
    (h) => !seedStockSymbols.has(h.symbol) && !isAlphaLockedHolding(h.symbol),
  );

  if (stockHoldings.length === 0 && etfHoldings.length === 0 && lockedHoldings.length === 0) return holdings;

  // Each stock keeps the SAME per-stock weight as the PIM base model
  const stockTotal = refPerStock * stockHoldings.length;

  // Locked specialty funds keep their existing weightInClass untouched
  const lockedTotal = lockedHoldings.reduce((s, h) => s + h.weightInClass, 0);

  // ── Residual rule: individual stocks fixed, Core ETFs absorb the gap ──
  //
  // Every individual stock carries the SAME weight in every model —
  // refPerStock — and the Core ETFs of that model take whatever is left.
  // Membership changes (a name added, or a name a model is not allowed to
  // own) therefore move the CORE sleeve, never the other stocks' weights.
  //
  // The inverse rule ran here for a while: Core/Alpha held their
  // manually-set weight and the stocks flexed to fill the residual. It is
  // a no-op on balanced data, which is why it survived, but it silently
  // repriced every stock in a model whenever ANYTHING else changed. Adding
  // LITE to KPMG dragged all 11 of its stocks from 1.20% to 1.09% of
  // portfolio — the stocks paid for the new holding instead of the Core
  // sleeve funding it. Same failure shape as PC USA, where a manual ITOT
  // weight was absorbed by the stocks rather than by Core.
  //
  // `groupId` is retained on the signature for call-site auditability.

  // Core (unlocked) ETFs absorb the remainder proportionally per PIM seed ratios
  const seedEtfWeights = new Map<string, number>();
  if (pimBaseGroup) {
    for (const h of pimBaseGroup.holdings) {
      if (
        h.assetClass === "equity" &&
        !seedStockSymbols.has(h.symbol) &&
        !isAlphaLockedHolding(h.symbol)
      ) {
        seedEtfWeights.set(h.symbol, h.weightInClass);
      }
    }
  }

  const etfTotal = Math.max(0, 1.0 - stockTotal - lockedTotal);
  const seedEtfTotal = [...seedEtfWeights.values()].reduce((s, v) => s + v, 0);

  // Three-bucket model: Core keeps its OWN current mix. The seed ratios
  // describe the pre-restructure Core (no QQC.F / QQQX.U), and mixing seed
  // ratios with current ones would not sum to etfTotal.
  // (useSeedRatios is passed in: true when the models carry no sleeveTargets)
  const rebalancedEtfs = etfHoldings.map((h) => {
    // Use seed ratio if available, otherwise preserve current ratio
    const seedWeight = useSeedRatios ? seedEtfWeights.get(h.symbol) : undefined;
    const ratio = seedWeight != null && seedEtfTotal > 0
      ? seedWeight / seedEtfTotal
      : (etfHoldings.length > 0 ? h.weightInClass / (etfHoldings.reduce((s, e) => s + e.weightInClass, 0) || 1) : 0);
    return { ...h, weightInClass: parseFloat((ratio * etfTotal).toFixed(6)) };
  });

  return [
    ...nonEquity,
    ...lockedHoldings, // untouched — weightInClass preserved exactly
    ...rebalancedEtfs,
    ...stockHoldings.map((h) => ({ ...h, weightInClass: refPerStock })),
  ];
}
