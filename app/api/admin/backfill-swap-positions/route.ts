import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimPortfolioPositions } from "@/app/lib/pim-types";

const POSITIONS_KEY = "pm:pim-positions";

/**
 * GET /api/admin/backfill-swap-positions?sold=SATS&bought=BK&sellPrice=119.2168&buyPrice=134.6536&usdCad=1.37
 *
 * Complements /api/admin/patch-stale-swap by populating pm:pim-positions
 * for every (group, profile) combination that still has a position entry
 * for the sold ticker.
 *
 * Math:
 *   proceeds_cad = soldUnits × sellPrice × sellFx
 *   boughtUnits  = proceeds_cad / (buyPrice × buyFx)
 *   costBasis    = buyPrice × buyFx  (per-unit CAD cost)
 *
 * Currency detection is based on ticker suffix:
 *   *.U           → USD
 *   *-T / *.TO    → CAD
 *   everything else → USD (matches the handler's defaults)
 *
 * `usdCad` query param overrides the FX rate; defaults to 1.37 if omitted.
 * Pass the current USD/CAD mid rate for accuracy.
 *
 * Safe to re-run: when the sold ticker's position is already gone, there's
 * nothing to do and the route reports zero changes.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sold = (url.searchParams.get("sold") || "").trim().toUpperCase();
    const bought = (url.searchParams.get("bought") || "").trim().toUpperCase();
    const sellPrice = Number(url.searchParams.get("sellPrice"));
    const buyPrice = Number(url.searchParams.get("buyPrice"));
    const usdCadRaw = url.searchParams.get("usdCad");
    const usdCad = usdCadRaw ? Number(usdCadRaw) : 1.37;

    if (!sold || !bought) {
      return NextResponse.json({ error: "sold and bought query params required" }, { status: 400 });
    }
    if (!isFinite(sellPrice) || sellPrice <= 0 || !isFinite(buyPrice) || buyPrice <= 0) {
      return NextResponse.json({ error: "sellPrice and buyPrice must be positive numbers" }, { status: 400 });
    }
    if (!isFinite(usdCad) || usdCad <= 0) {
      return NextResponse.json({ error: "usdCad must be a positive number" }, { status: 400 });
    }

    const tickerEq = (a: string, b: string) =>
      a === b || a.replace("-T", ".TO") === b.replace("-T", ".TO");

    const currencyOf = (t: string): "CAD" | "USD" =>
      t.endsWith(".U") ? "USD" : t.endsWith("-T") || t.endsWith(".TO") ? "CAD" : "USD";

    const sellFx = currencyOf(sold) === "USD" ? usdCad : 1;
    const buyFx = currencyOf(bought) === "USD" ? usdCad : 1;
    const buyCostBasisCad = buyPrice * buyFx;

    const redis = await getRedis();
    const raw = await redis.get(POSITIONS_KEY);
    if (!raw) {
      return NextResponse.json({
        ok: true,
        message: "pm:pim-positions not found — nothing to backfill.",
        changes: [],
      });
    }

    const parsed = JSON.parse(raw) as { portfolios?: PimPortfolioPositions[] };
    const portfolios: PimPortfolioPositions[] = parsed.portfolios || [];

    type Change = {
      groupId: string;
      profile: string;
      soldUnits: number;
      proceedsCad: number;
      boughtUnits: number;
      costBasisCad: number;
      merged: boolean; // true if bought ticker already had a position and we merged
    };
    const changes: Change[] = [];

    const updatedPortfolios = portfolios.map((pp) => {
      const soldPos = pp.positions.find((p) => tickerEq(p.symbol, sold));
      if (!soldPos || soldPos.units <= 0) return pp;

      const proceedsCad = soldPos.units * sellPrice * sellFx;
      const boughtUnits = buyCostBasisCad > 0 ? proceedsCad / buyCostBasisCad : 0;

      const withoutSold = pp.positions.filter((p) => !tickerEq(p.symbol, sold));
      const existingBought = withoutSold.find((p) => tickerEq(p.symbol, bought));

      let nextPositions;
      let merged = false;
      if (existingBought) {
        merged = true;
        const mergedUnits = existingBought.units + boughtUnits;
        const mergedCostBasis =
          mergedUnits > 0
            ? (existingBought.units * existingBought.costBasis + boughtUnits * buyCostBasisCad) / mergedUnits
            : buyCostBasisCad;
        nextPositions = withoutSold.map((p) =>
          tickerEq(p.symbol, bought)
            ? { ...p, units: mergedUnits, costBasis: mergedCostBasis }
            : p
        );
      } else {
        nextPositions = [
          ...withoutSold,
          { symbol: bought, units: boughtUnits, costBasis: buyCostBasisCad },
        ];
      }

      changes.push({
        groupId: pp.groupId,
        profile: pp.profile,
        soldUnits: soldPos.units,
        proceedsCad: parseFloat(proceedsCad.toFixed(2)),
        boughtUnits: parseFloat(boughtUnits.toFixed(4)),
        costBasisCad: parseFloat(buyCostBasisCad.toFixed(4)),
        merged,
      });

      return { ...pp, positions: nextPositions, lastUpdated: new Date().toISOString() };
    });

    if (changes.length === 0) {
      return NextResponse.json({
        ok: true,
        message: `${sold} was not found in any (group, profile) position entries — nothing to backfill.`,
        changes,
      });
    }

    await redis.set(POSITIONS_KEY, JSON.stringify({ portfolios: updatedPortfolios }));

    return NextResponse.json({
      ok: true,
      sold,
      bought,
      sellPrice,
      buyPrice,
      usdCad,
      sellCurrency: currencyOf(sold),
      buyCurrency: currencyOf(bought),
      buyCostBasisCad: parseFloat(buyCostBasisCad.toFixed(4)),
      changesCount: changes.length,
      changes,
      note: `Reload the Positioning tab — units, value (CAD), ACB, current %, and gain/loss for ${bought} should now populate.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
