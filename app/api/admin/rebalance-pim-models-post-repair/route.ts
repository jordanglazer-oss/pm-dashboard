/**
 * POST /api/admin/rebalance-pim-models-post-repair?confirm=YES
 *
 * Third-pass surgical repair for pm:pim-models damage caused by the
 * original /api/admin/repair-multi-trade-202605 script.
 *
 * What the original repair did to pm:pim-models:
 *   - Added CS.TO holding to every group that already held ABX.TO, with the
 *     same weightInClass as that group's ABX (so e.g. 0.018759 in pim),
 *     and `name: "CELESTICA"` (WRONG — CS.TO is Capstone Copper).
 *   - Did NOT re-run the equity rebalance after adding the holdings, so
 *     equity weights in every affected group now sum to >100% (i.e. the
 *     Core ETF weights remain sized for the OLD number of stocks).
 *
 * Compounding pre-existing bug:
 *   - StockContext.tsx's `rebalanceStockWeights` used a hardcoded LOCKED
 *     set of {FID5982, FID5982-T, GRNJ}. But pm:stocks has SIX holdings
 *     tagged designation:"alpha" (XSU.TO, VTWO, FINN.NE, GRNJ, FID5982).
 *     Every prior add/remove of a stock has been silently re-scaling
 *     XSU.TO / VTWO / FINN.NE along with the Core ETFs, drifting their
 *     weights away from their seed values over time.
 *
 * This endpoint (touches ONLY pm:pim-models):
 *   1. Stashes the current pm:pim-models to pm:pre-rebalance-stash:{ts}
 *      as the FIRST write — full rollback via /api/admin/undo-rebalance.
 *   2. For every group in pm:pim-models:
 *      a. Renames any holding with symbol matching CS.TO and name === "CELESTICA"
 *         → name: "CAPSTONE COPPER CORP".
 *      b. Classifies each equity holding using:
 *         - "stock" if instrumentType === "stock" in pm:stocks (or detected
 *           via the seed convention of weightInClass ≈ 0.018182).
 *         - "alpha-locked" if pm:stocks designation === "alpha" (or unset,
 *           with a LEGACY_LOCKED_EQUITY_SYMBOLS fallback for holdings missing
 *           a pm:stocks entry entirely).
 *         - "core" if pm:stocks designation === "core".
 *      c. Sets every stock's weightInClass to 0.018182 (standard).
 *      d. Restores every alpha-locked holding's weightInClass to the
 *         per-group seed value from pim-seed.ts (where available; if seed
 *         doesn't have it, preserves current weight).
 *      e. Rescales every Core holding's weightInClass to absorb the residual
 *         (1 - stockSum - alphaSum), distributed by the same PIM-base
 *         seed-ratio algorithm used by StockContext.rebalanceStockWeights.
 *   3. Writes the updated pm:pim-models back.
 *
 * GUARDED: requires ?confirm=YES. Idempotent in the sense that re-running
 * after a successful write produces the same output (since all weights are
 * deterministic from the seed). The stash mechanism makes every write
 * reversible regardless.
 *
 * Functionality contract: no holdings added or removed; only weightInClass
 * (and the one CS.TO name) modified. Fixed income and alternative holdings
 * are not touched (their weightInClass values are user-set and already
 * sum to 1.0 per class).
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { pimModelSeed } from "@/app/lib/pim-seed";

const REF_PER_STOCK = 0.018182;
const LEGACY_LOCKED_EQUITY_SYMBOLS = new Set(["FID5982", "FID5982-T", "GRNJ"]);

const normalizeTicker = (s: string): string => s.toUpperCase().replace(/-T$/, ".TO");
const tickerEq = (a: string | undefined, b: string): boolean => {
  if (!a) return false;
  return normalizeTicker(a) === normalizeTicker(b);
};

type StockLike = {
  ticker?: string;
  instrumentType?: string;
  designation?: "core" | "alpha";
  bucket?: string;
};

type Holding = {
  symbol: string;
  name?: string;
  currency?: string;
  assetClass?: "fixedIncome" | "equity" | "alternative";
  weightInClass: number;
  [k: string]: unknown;
};

type Group = {
  id: string;
  name: string;
  holdings: Holding[];
  [k: string]: unknown;
};

type PimModelData = {
  groups?: Group[];
  lastUpdated?: string;
  [k: string]: unknown;
};

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      { error: "Add ?confirm=YES to actually run the rebalance. This endpoint mutates Redis." },
      { status: 400 },
    );
  }

  try {
    const redis = await getRedis();
    const [stocksRaw, pimRaw] = await Promise.all([
      redis.get("pm:stocks"),
      redis.get("pm:pim-models"),
    ]);

    if (!stocksRaw) {
      return NextResponse.json(
        { error: "pm:stocks missing — refusing to operate" },
        { status: 500 },
      );
    }
    if (!pimRaw) {
      return NextResponse.json(
        { error: "pm:pim-models missing — refusing to operate" },
        { status: 500 },
      );
    }

    const stocksParsed = JSON.parse(stocksRaw) as unknown;
    if (!Array.isArray(stocksParsed)) {
      return NextResponse.json(
        {
          error:
            "pm:stocks is not a proper array — run /api/admin/repair-multi-trade-202605-cleanup first",
        },
        { status: 500 },
      );
    }
    const stocks: StockLike[] = stocksParsed as StockLike[];

    const pimParsed = JSON.parse(pimRaw) as PimModelData;
    const groups: Group[] = Array.isArray(pimParsed.groups) ? pimParsed.groups : [];
    if (groups.length === 0) {
      return NextResponse.json({ error: "pm:pim-models has no groups" }, { status: 500 });
    }

    // ── Stash current state BEFORE any write ──
    const stashTs = new Date().toISOString();
    const stashKey = `pm:pre-rebalance-stash:${stashTs}`;
    await redis.set(
      stashKey,
      JSON.stringify({
        stashedAt: stashTs,
        reason: "rebalance-pim-models-post-repair",
        "pm:pim-models": pimRaw,
      }),
    );

    // ── Build classification helpers ──
    // Build the seed-defined "stock" symbol set (any equity holding in any
    // seed group whose weightInClass ≈ REF_PER_STOCK), plus any Portfolio-
    // bucket stock in pm:stocks. Mirrors the existing rebalanceStockWeights.
    const seedStockSymbols = new Set<string>();
    for (const sg of pimModelSeed) {
      for (const h of sg.holdings) {
        if (h.assetClass === "equity" && Math.abs(h.weightInClass - REF_PER_STOCK) < 0.001) {
          seedStockSymbols.add(h.symbol);
          seedStockSymbols.add(h.symbol.replace(/-T$/, ".TO"));
          seedStockSymbols.add(h.symbol.replace(/\.TO$/, "-T"));
        }
      }
    }
    for (const s of stocks) {
      if (!s.ticker) continue;
      if (s.bucket === "Portfolio" && (!s.instrumentType || s.instrumentType === "stock")) {
        seedStockSymbols.add(s.ticker);
        seedStockSymbols.add(s.ticker.replace(".TO", "-T"));
        seedStockSymbols.add(s.ticker.replace("-T", ".TO"));
      }
    }

    // Build a map of normalized-ticker → presence-and-designation. Anything
    // that has a pm:stocks entry but isn't explicitly tagged "core" defaults
    // to Alpha (locked) — matches the UI default in PortfolioOverview where
    // `(s.designation || "alpha") === "core"` controls the Role badge, and
    // types.ts documents the field as "default alpha".
    type DesigInfo = { hasEntry: true; designation: "core" | "alpha" | undefined };
    const designationByNormTicker = new Map<string, DesigInfo>();
    for (const s of stocks) {
      if (!s.ticker) continue;
      const norm = normalizeTicker(s.ticker);
      designationByNormTicker.set(norm, {
        hasEntry: true,
        designation:
          s.designation === "core" || s.designation === "alpha" ? s.designation : undefined,
      });
    }

    const isAlphaLocked = (symbol: string): boolean => {
      const norm = normalizeTicker(symbol);
      const info = designationByNormTicker.get(norm);
      if (info) {
        // pm:stocks entry exists — Alpha unless EXPLICITLY tagged Core
        return info.designation !== "core";
      }
      // No pm:stocks entry at all → legacy fallback
      return LEGACY_LOCKED_EQUITY_SYMBOLS.has(symbol);
    };

    // (Per-group seed Core ETF distribution is computed inline below — no
    // PIM-base lookup needed. Each group's freed CAD weight flows only into
    // that group's CAD Core ETFs by their seed ratios, and same for USD.
    // This preserves cadSplit/usdSplit when stocks are missing relative to
    // seed.)

    // ── Process each group ──
    const groupDiffs: Array<{
      groupId: string;
      csRenamed: boolean;
      stocksReset: Array<{ symbol: string; before: number; after: number }>;
      alphaRestored: Array<{ symbol: string; before: number; after: number; usedSeed: boolean }>;
      coreRescaled: Array<{ symbol: string; before: number; after: number }>;
      equityClassSumBefore: number;
      equityClassSumAfter: number;
    }> = [];

    const updatedGroups: Group[] = groups.map((group): Group => {
      // Per-group seed equity weights for Alpha restoration AND for Core
      // ETF currency-aware redistribution. Also capture each seed holding's
      // currency so we know the seed's CAD/USD split per role.
      const groupSeed = pimModelSeed.find((g) => g.id === group.id);
      const seedAlphaWeights = new Map<string, number>();
      const seedCoreCadWeights = new Map<string, number>(); // symbol → seed weight (CAD core ETFs)
      const seedCoreUsdWeights = new Map<string, number>(); // symbol → seed weight (USD core ETFs)
      let seedCadEquityTotal = 0;
      let seedUsdEquityTotal = 0;
      if (groupSeed) {
        for (const h of groupSeed.holdings) {
          if (h.assetClass !== "equity") continue;
          const norm = normalizeTicker(h.symbol);
          seedAlphaWeights.set(norm, h.weightInClass);
          const cur = h.currency === "USD" ? "USD" : "CAD";
          if (cur === "CAD") seedCadEquityTotal += h.weightInClass;
          else seedUsdEquityTotal += h.weightInClass;
          // We only need core seed ratios for symbols that turn out to be Core
          // ETFs in the live data (decided in the first pass below), but
          // capturing every non-stock-non-alpha seed entry is fine.
          if (
            Math.abs(h.weightInClass - REF_PER_STOCK) > 0.001 &&
            !isAlphaLocked(h.symbol)
          ) {
            if (cur === "CAD") seedCoreCadWeights.set(h.symbol, h.weightInClass);
            else seedCoreUsdWeights.set(h.symbol, h.weightInClass);
          }
        }
      }

      const equityBefore = group.holdings
        .filter((h) => h.assetClass === "equity")
        .reduce((s, h) => s + (h.weightInClass || 0), 0);

      const stocksReset: Array<{ symbol: string; before: number; after: number }> = [];
      const alphaRestored: Array<{ symbol: string; before: number; after: number; usedSeed: boolean }> = [];
      const coreRescaled: Array<{ symbol: string; before: number; after: number }> = [];
      let csRenamed = false;

      // First pass: classify each equity holding, tracking currency for the
      // stock/locked sums so we can compute per-currency Core residuals.
      let cadStockCount = 0;
      let usdStockCount = 0;
      let cadLockedSum = 0;
      let usdLockedSum = 0;
      const coreCadHoldings: Array<{ symbol: string }> = [];
      const coreUsdHoldings: Array<{ symbol: string }> = [];

      const holdingCurrency = (h: Holding): "CAD" | "USD" =>
        h.currency === "USD" ? "USD" : "CAD";

      for (const h of group.holdings) {
        if (h.assetClass !== "equity") continue;
        const cur = holdingCurrency(h);
        if (seedStockSymbols.has(h.symbol)) {
          if (cur === "CAD") cadStockCount++;
          else usdStockCount++;
        } else if (isAlphaLocked(h.symbol)) {
          const seedW = seedAlphaWeights.get(normalizeTicker(h.symbol));
          const restoredWeight = seedW !== undefined ? seedW : h.weightInClass;
          if (cur === "CAD") cadLockedSum += restoredWeight;
          else usdLockedSum += restoredWeight;
        } else {
          if (cur === "CAD") coreCadHoldings.push({ symbol: h.symbol });
          else coreUsdHoldings.push({ symbol: h.symbol });
        }
      }

      const cadStockSum = cadStockCount * REF_PER_STOCK;
      const usdStockSum = usdStockCount * REF_PER_STOCK;

      // Per-currency residual: each currency's Core ETFs absorb only the
      // freed weight WITHIN that currency, preserving the group's seed
      // CAD/USD equity split even when stocks are missing relative to seed.
      const cadCoreResidual = Math.max(0, seedCadEquityTotal - cadStockSum - cadLockedSum);
      const usdCoreResidual = Math.max(0, seedUsdEquityTotal - usdStockSum - usdLockedSum);

      // Sum of seed weights for the Core holdings actually present in the
      // live group (per currency), used to scale the residual proportionally.
      const cadSeedCoreTotal = coreCadHoldings.reduce(
        (s, e) => s + (seedCoreCadWeights.get(e.symbol) ?? 0),
        0,
      );
      const usdSeedCoreTotal = coreUsdHoldings.reduce(
        (s, e) => s + (seedCoreUsdWeights.get(e.symbol) ?? 0),
        0,
      );

      // Second pass: apply changes
      const newHoldings: Holding[] = group.holdings.map((h): Holding => {
        // Rename CS.TO mislabel
        if (tickerEq(h.symbol, "CS.TO") && h.name === "CELESTICA") {
          csRenamed = true;
          h = { ...h, name: "CAPSTONE COPPER CORP" };
        }

        // Only touch equity holdings
        if (h.assetClass !== "equity") return h;

        if (seedStockSymbols.has(h.symbol)) {
          if (Math.abs(h.weightInClass - REF_PER_STOCK) > 0.000001) {
            stocksReset.push({ symbol: h.symbol, before: h.weightInClass, after: REF_PER_STOCK });
          }
          return { ...h, weightInClass: REF_PER_STOCK };
        }

        if (isAlphaLocked(h.symbol)) {
          const seedW = seedAlphaWeights.get(normalizeTicker(h.symbol));
          const restoredWeight = seedW !== undefined ? seedW : h.weightInClass;
          if (Math.abs(h.weightInClass - restoredWeight) > 0.000001) {
            alphaRestored.push({
              symbol: h.symbol,
              before: h.weightInClass,
              after: restoredWeight,
              usedSeed: seedW !== undefined,
            });
          }
          return { ...h, weightInClass: restoredWeight };
        }

        // Core ETF — distribute this currency's residual to this currency's
        // Core ETFs only, by seed-ratio (within that currency bucket).
        const cur = holdingCurrency(h);
        const seedMap = cur === "CAD" ? seedCoreCadWeights : seedCoreUsdWeights;
        const seedTotal = cur === "CAD" ? cadSeedCoreTotal : usdSeedCoreTotal;
        const residualForCur = cur === "CAD" ? cadCoreResidual : usdCoreResidual;
        const seedW = seedMap.get(h.symbol);
        const ratio = seedW !== undefined && seedTotal > 0 ? seedW / seedTotal : 0;
        const newWeight = parseFloat((ratio * residualForCur).toFixed(6));
        if (Math.abs(h.weightInClass - newWeight) > 0.000001) {
          coreRescaled.push({ symbol: h.symbol, before: h.weightInClass, after: newWeight });
        }
        return { ...h, weightInClass: newWeight };
      });

      const equityAfter = newHoldings
        .filter((h) => h.assetClass === "equity")
        .reduce((s, h) => s + (h.weightInClass || 0), 0);

      groupDiffs.push({
        groupId: group.id,
        csRenamed,
        stocksReset,
        alphaRestored,
        coreRescaled,
        equityClassSumBefore: parseFloat(equityBefore.toFixed(6)),
        equityClassSumAfter: parseFloat(equityAfter.toFixed(6)),
      });

      return { ...group, holdings: newHoldings };
    });

    // ── Idempotency check: if nothing changed, don't bother writing ──
    const totalChanges = groupDiffs.reduce(
      (n, g) =>
        n +
        (g.csRenamed ? 1 : 0) +
        g.stocksReset.length +
        g.alphaRestored.length +
        g.coreRescaled.length,
      0,
    );
    if (totalChanges === 0) {
      return NextResponse.json({
        ok: true,
        status: "no-op",
        note: "All groups already at correct weights and names. No write performed.",
        stashKey,
        groupDiffs,
      });
    }

    // ── Write back ──
    await redis.set(
      "pm:pim-models",
      JSON.stringify({ ...pimParsed, groups: updatedGroups, lastUpdated: stashTs }),
    );

    return NextResponse.json({
      ok: true,
      status: "rebalanced",
      stashKey,
      undoUrl: `/api/admin/undo-rebalance?stashKey=${encodeURIComponent(stashKey)}&confirm=YES`,
      totalChanges,
      groupDiffs,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Rebalance failed" },
      { status: 500 },
    );
  }
}
