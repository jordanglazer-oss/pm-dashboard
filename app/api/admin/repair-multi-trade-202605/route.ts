/**
 * POST /api/admin/repair-multi-trade-202605?confirm=YES
 *
 * One-shot surgical repair for the stale-closure bug that hit
 * Jordan's two-trade Buy/Sell session on 2026-05-25:
 *
 *   Trade 1: ARX.TO 100% → ABX.TO @ $58.17361   (proceeds @ $30.73799)
 *   Trade 2: NPI.TO 100% → CS.TO @ (already correct)
 *
 * What landed in Redis after the bug:
 *   - pm:pim-models has ABX (good), NPI removed (good), but CS missing
 *   - pm:pim-positions has ARX (stale, should be gone), no ABX (lost),
 *     CS present (good)
 *   - pm:stocks missing ABX + CS as Portfolio entries
 *
 * What this endpoint does (atomic per-blob writes, no partial state):
 *   1. pm:pim-positions: remove ARX from every (group, profile);
 *      add ABX with units = ARX_units × (ARX_sell / ABX_buy),
 *      costBasis = ABX_buy. CS positions stay as-is.
 *   2. pm:pim-models: in every group that already has ABX, also add CS
 *      at the same weightInClass (both individual stocks → identical
 *      lock weight in any given group).
 *   3. pm:stocks: append ABX + CS as Portfolio bucket entries if not
 *      already present.
 *
 * GUARDED:
 *   - Requires ?confirm=YES query param (prevents accidental hits).
 *   - One-shot: hardcoded for these specific tickers and prices.
 *   - Idempotent at the stocks layer (skips if already present).
 *   - NOT idempotent at positions / pim-models — if called twice would
 *     double-add ABX positions. Run it ONCE.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const ARX_SELL_PRICE = 30.73799;
const ABX_BUY_PRICE = 58.17361;
const SCALE = ARX_SELL_PRICE / ABX_BUY_PRICE;

type Holding = {
  symbol: string;
  name: string;
  currency: "CAD" | "USD";
  assetClass: "fixedIncome" | "equity" | "alternative";
  weightInClass: number;
};
type Group = { id: string; name: string; holdings: Holding[] };
type PimModelData = { groups: Group[]; lastUpdated?: string };

type Position = { symbol: string; units: number; costBasis: number };
type Portfolio = {
  groupId: string;
  profile: string;
  positions: Position[];
  cashBalance?: number;
  lastUpdated?: string;
};
type Positions = { portfolios: Portfolio[] };

type Stock = {
  ticker: string;
  name: string;
  bucket: "Portfolio" | "Watchlist";
  sector: string;
  beta: number;
  weights: { portfolio: number };
  scores: Record<string, number>;
  notes?: string;
  instrumentType?: string;
};

const ZERO_SCORES: Record<string, number> = {
  brand: 0, secular: 0, researchCoverage: 0, externalSources: 0,
  analystConsensus: 0, researchMentions: 0,
  charting: 0, relativeStrength: 0, aiRating: 0, growth: 0,
  relativeValuation: 0, historicalValuation: 0, leverageCoverage: 0,
  cashFlowQuality: 0, competitiveMoat: 0, turnaround: 0, catalysts: 0,
  trackRecord: 0, ownershipTrends: 0,
};

const tickerEq = (a: string, b: string) => {
  const an = a.toUpperCase().replace("-T", ".TO");
  const bn = b.toUpperCase().replace("-T", ".TO");
  return an === bn;
};

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      { error: "Add ?confirm=YES to actually run the repair. This endpoint mutates Redis." },
      { status: 400 },
    );
  }

  try {
    const redis = await getRedis();
    const [pimRaw, posRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:stocks"),
    ]);

    if (!pimRaw || !posRaw) {
      return NextResponse.json({ error: "Missing pm:pim-models or pm:pim-positions in Redis" }, { status: 500 });
    }

    const pim: PimModelData = JSON.parse(pimRaw);
    const pos: Positions = JSON.parse(posRaw);
    const stocksBlob: { stocks: Stock[] } = stocksRaw ? JSON.parse(stocksRaw) : { stocks: [] };
    const stocks: Stock[] = Array.isArray(stocksBlob.stocks) ? stocksBlob.stocks : [];

    const nowIso = new Date().toISOString();
    const summary: {
      positionsBefore: Array<{ groupId: string; profile: string; arxUnits: number; abxUnits: number; csUnits: number }>;
      positionsAfter: Array<{ groupId: string; profile: string; arxUnits: number; abxUnits: number; csUnits: number }>;
      pimModelsCsAdditions: Array<{ groupId: string; weightInClass: number }>;
      stocksAdded: string[];
    } = { positionsBefore: [], positionsAfter: [], pimModelsCsAdditions: [], stocksAdded: [] };

    // ── 1. Rewrite pim-positions: remove ARX, add ABX. CS stays as-is.
    const updatedPortfolios = pos.portfolios.map((p) => {
      const arx = p.positions.find((pp) => tickerEq(pp.symbol, "ARX.TO"));
      const abx = p.positions.find((pp) => tickerEq(pp.symbol, "ABX.TO"));
      const cs = p.positions.find((pp) => tickerEq(pp.symbol, "CS.TO"));
      summary.positionsBefore.push({
        groupId: p.groupId,
        profile: p.profile,
        arxUnits: arx?.units ?? 0,
        abxUnits: abx?.units ?? 0,
        csUnits: cs?.units ?? 0,
      });

      if (!arx || arx.units <= 0) {
        summary.positionsAfter.push({
          groupId: p.groupId,
          profile: p.profile,
          arxUnits: 0,
          abxUnits: abx?.units ?? 0,
          csUnits: cs?.units ?? 0,
        });
        return p;
      }

      const abxNewUnits = arx.units * SCALE;
      const withoutArx = p.positions.filter((pp) => !tickerEq(pp.symbol, "ARX.TO"));

      let nextPositions: Position[];
      if (abx) {
        // Merge into existing ABX position with weighted-average costBasis.
        const mergedUnits = abx.units + abxNewUnits;
        const mergedCostBasis =
          mergedUnits > 0
            ? (abx.units * abx.costBasis + abxNewUnits * ABX_BUY_PRICE) / mergedUnits
            : ABX_BUY_PRICE;
        nextPositions = withoutArx.map((pp) =>
          tickerEq(pp.symbol, "ABX.TO")
            ? { ...pp, units: mergedUnits, costBasis: mergedCostBasis }
            : pp
        );
      } else {
        nextPositions = [
          ...withoutArx,
          { symbol: "ABX.TO", units: abxNewUnits, costBasis: ABX_BUY_PRICE },
        ];
      }

      summary.positionsAfter.push({
        groupId: p.groupId,
        profile: p.profile,
        arxUnits: 0,
        abxUnits: abxNewUnits,
        csUnits: cs?.units ?? 0,
      });

      return { ...p, positions: nextPositions, lastUpdated: nowIso };
    });

    // ── 2. Add CS to pim-models in every group that has ABX.
    const updatedGroups = pim.groups.map((g) => {
      const abxHolding = g.holdings.find((h) => h.symbol && tickerEq(h.symbol, "ABX.TO"));
      const csAlreadyPresent = g.holdings.some((h) => h.symbol && tickerEq(h.symbol, "CS.TO"));
      if (!abxHolding || csAlreadyPresent) return g;
      const csHolding: Holding = {
        symbol: "CS.TO",
        name: "CELESTICA",
        currency: "CAD",
        assetClass: abxHolding.assetClass,
        weightInClass: abxHolding.weightInClass,
      };
      summary.pimModelsCsAdditions.push({
        groupId: g.id,
        weightInClass: abxHolding.weightInClass,
      });
      return { ...g, holdings: [...g.holdings, csHolding] };
    });

    // ── 3. Add ABX + CS to pm:stocks as Portfolio entries if absent.
    let updatedStocks = stocks.slice();
    const haveAbx = updatedStocks.some((s) => tickerEq(s.ticker, "ABX.TO"));
    if (!haveAbx) {
      updatedStocks = [
        {
          ticker: "ABX.TO",
          name: "BARRICK MINING CORPORATION",
          instrumentType: "stock",
          bucket: "Portfolio",
          sector: "Materials",
          beta: 1.0,
          weights: { portfolio: 2 },
          scores: { ...ZERO_SCORES },
          notes: "Restored via repair-multi-trade-202605",
        },
        ...updatedStocks,
      ];
      summary.stocksAdded.push("ABX.TO");
    }
    const haveCs = updatedStocks.some((s) => tickerEq(s.ticker, "CS.TO"));
    if (!haveCs) {
      updatedStocks = [
        {
          ticker: "CS.TO",
          name: "CELESTICA",
          instrumentType: "stock",
          bucket: "Portfolio",
          sector: "Technology",
          beta: 1.0,
          weights: { portfolio: 2 },
          scores: { ...ZERO_SCORES },
          notes: "Restored via repair-multi-trade-202605",
        },
        ...updatedStocks,
      ];
      summary.stocksAdded.push("CS.TO");
    }

    // ── Atomic-ish triple write. Done last + sequentially so any
    // failure leaves us in a recoverable state. Worst case if (1)
    // succeeds and (2) fails: positions are correct but pim-models
    // missing CS — same end state as today minus the ABX/ARX fix,
    // we can re-run with knowledge of what landed.
    await redis.set("pm:pim-positions", JSON.stringify({ portfolios: updatedPortfolios }));
    await redis.set("pm:pim-models", JSON.stringify({ ...pim, groups: updatedGroups, lastUpdated: nowIso }));
    await redis.set("pm:stocks", JSON.stringify({ ...stocksBlob, stocks: updatedStocks }));

    return NextResponse.json({
      ok: true,
      scaleFactor: SCALE,
      arxSellPrice: ARX_SELL_PRICE,
      abxBuyPrice: ABX_BUY_PRICE,
      summary,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Repair failed" },
      { status: 500 },
    );
  }
}
