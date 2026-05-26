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

    // ── PIM base group seed ratios for Core ETF redistribution ──
    // Mirrors StockContext.rebalanceStockWeights' seed-ratio approach so
    // server-side rebalance produces results identical to what the UI
    // would produce after a clean add-remove cycle.
    const pimBaseSeed = pimModelSeed.find((g) => g.id === "pim");
    const pimBaseSeedEtfWeights = new Map<string, number>();
    if (pimBaseSeed) {
      for (const h of pimBaseSeed.holdings) {
        if (
          h.assetClass === "equity" &&
          !seedStockSymbols.has(h.symbol) &&
          !isAlphaLocked(h.symbol)
        ) {
          pimBaseSeedEtfWeights.set(h.symbol, h.weightInClass);
        }
      }
    }
    const pimBaseSeedEtfTotal = [...pimBaseSeedEtfWeights.values()].reduce((s, v) => s + v, 0);

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
      // Per-group seed equity weights for Alpha restoration
      const groupSeed = pimModelSeed.find((g) => g.id === group.id);
      const seedAlphaWeights = new Map<string, number>();
      if (groupSeed) {
        for (const h of groupSeed.holdings) {
          if (h.assetClass === "equity") {
            const norm = normalizeTicker(h.symbol);
            seedAlphaWeights.set(norm, h.weightInClass);
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

      // First pass: identify stocks, locked, core; compute residual
      let numStocks = 0;
      let lockedSum = 0;
      const coreHoldingsInGroup: Array<{ symbol: string; before: number }> = [];

      for (const h of group.holdings) {
        if (h.assetClass !== "equity") continue;
        if (seedStockSymbols.has(h.symbol)) {
          numStocks++;
        } else if (isAlphaLocked(h.symbol)) {
          // Determine restored alpha weight: per-group seed value if present
          const seedW = seedAlphaWeights.get(normalizeTicker(h.symbol));
          const restoredWeight = seedW !== undefined ? seedW : h.weightInClass;
          lockedSum += restoredWeight;
        } else {
          coreHoldingsInGroup.push({ symbol: h.symbol, before: h.weightInClass || 0 });
        }
      }

      const stockSum = numStocks * REF_PER_STOCK;
      const residual = Math.max(0, 1.0 - stockSum - lockedSum);

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

        // Core ETF — scale to residual via PIM base seed ratio when known
        const seedW = pimBaseSeedEtfWeights.get(h.symbol);
        const currentCoreSum = coreHoldingsInGroup.reduce((s, e) => s + e.before, 0);
        const ratio = seedW !== undefined && pimBaseSeedEtfTotal > 0
          ? seedW / pimBaseSeedEtfTotal
          : (currentCoreSum > 0 ? h.weightInClass / currentCoreSum : 0);
        const newWeight = parseFloat((ratio * residual).toFixed(6));
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
