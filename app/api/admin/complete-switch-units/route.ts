import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const POSITIONS_KEY = "pm:pim-positions";

/**
 * POST /api/admin/complete-switch-units
 *
 * Finishes the POSITION leg of a switch whose model leg already ran.
 *
 * A Buy/Sell switch does two things: swap the holding in pm:pim-models, and
 * convert the units in pm:pim-positions. The TOU.TO → CCO.TO trade did the
 * first and not the second, leaving CCO.TO present in nine model groups with
 * no shares anywhere — a holding worth nothing to performance. The sold units
 * were never consumed, so nothing is lost and no restore is needed: the trade
 * simply has to be completed.
 *
 * Body:
 *   sellSymbol  e.g. "TOU.TO"     — the position being converted
 *   buySymbol   e.g. "CCO.TO"     — the position being created
 *   sellPrice   execution price of the sale, in the sold instrument's currency
 *   buyPrice    execution price of the buy, in the bought instrument's currency
 *   usdCadRate  only needed if either leg is USD (default 1)
 *   groupId     optional filter; omit to convert every group that holds it
 *   confirm     must be exactly "APPLY" to write. Anything else = DRY RUN.
 *
 * Math, per (group, profile) — identical to the executor's:
 *   proceedsCad = units × sellPrice × sellFx
 *   buyUnits    = proceedsCad / (buyPrice × buyFx)
 *   costBasis   = buyPrice × buyFx      (per-unit, CAD, as stored)
 * Value is conserved: buyUnits × buyPrice × buyFx === proceedsCad.
 *
 * SAFETY:
 *   - DRY RUN by default; returns exactly what it would write.
 *   - Read-modify-write: every other group, profile, position and the cash
 *     balance are preserved untouched.
 *   - Refuses any (group, profile) that already holds buySymbol, so it cannot
 *     double-book if run twice.
 *   - Touches ONLY pm:pim-positions. pm:pim-models is left alone.
 */

type Position = { symbol: string; units: number; costBasis: number };
type Portfolio = { groupId: string; profile: string; positions: Position[]; cashBalance: number; lastUpdated: string };

const eq = (a: string, b: string) =>
  a.toUpperCase() === b.toUpperCase() ||
  a.toUpperCase().replace("-T", ".TO") === b.toUpperCase().replace("-T", ".TO");

const isUsd = (s: string) => !(s.endsWith(".U") || s.endsWith("-T") || s.endsWith(".TO"));

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const sellSymbol = String(body?.sellSymbol || "").trim();
    const buySymbol = String(body?.buySymbol || "").trim();
    const sellPrice = Number(body?.sellPrice);
    const buyPrice = Number(body?.buyPrice);
    const usdCadRate = Number(body?.usdCadRate) || 1;
    const groupId = body?.groupId ? String(body.groupId) : null;
    const apply = body?.confirm === "APPLY";

    if (!sellSymbol || !buySymbol) {
      return NextResponse.json({ error: "sellSymbol and buySymbol are required" }, { status: 400 });
    }
    if (!(sellPrice > 0) || !(buyPrice > 0)) {
      return NextResponse.json({ error: "sellPrice and buyPrice must be positive" }, { status: 400 });
    }

    const redis = await getRedis();
    const raw = await redis.get(POSITIONS_KEY);
    if (!raw) return NextResponse.json({ error: "pm:pim-positions is empty" }, { status: 404 });
    const parsed = JSON.parse(raw) as { portfolios?: Portfolio[] };
    const portfolios = parsed.portfolios ?? [];

    const sellFx = isUsd(sellSymbol) ? usdCadRate : 1;
    const buyFx = isUsd(buySymbol) ? usdCadRate : 1;
    const costBasis = buyPrice * buyFx;

    const plan: unknown[] = [];
    const blocked: string[] = [];

    const next = portfolios.map((pp) => {
      if (groupId && pp.groupId !== groupId) return pp;
      const sold = pp.positions.find((p) => eq(p.symbol, sellSymbol));
      if (!sold || sold.units <= 0) return pp;

      if (pp.positions.some((p) => eq(p.symbol, buySymbol))) {
        blocked.push(`${pp.groupId}/${pp.profile} already holds ${buySymbol}`);
        return pp;
      }

      const proceedsCad = sold.units * sellPrice * sellFx;
      const buyUnits = proceedsCad / costBasis;

      plan.push({
        groupId: pp.groupId,
        profile: pp.profile,
        sold: { symbol: sold.symbol, units: sold.units, costBasis: sold.costBasis },
        proceedsCad: +proceedsCad.toFixed(2),
        bought: { symbol: buySymbol, units: +buyUnits.toFixed(4), costBasis: +costBasis.toFixed(4) },
        valueCheck: +(buyUnits * costBasis).toFixed(2),
      });

      if (!apply) return pp;
      return {
        ...pp,
        positions: [
          ...pp.positions.filter((p) => !eq(p.symbol, sellSymbol)),
          { symbol: buySymbol, units: +buyUnits.toFixed(4), costBasis: +costBasis.toFixed(4) },
        ],
        lastUpdated: new Date().toISOString(),
      };
    });

    if (!apply) {
      return NextResponse.json({
        dryRun: true,
        note: 'Nothing written. Re-send with "confirm":"APPLY" to commit exactly this.',
        wouldConvert: plan.length,
        plan,
        blocked,
      });
    }

    await redis.set(POSITIONS_KEY, JSON.stringify({ ...parsed, portfolios: next }));
    return NextResponse.json({ applied: true, converted: plan.length, plan, blocked });
  } catch (e) {
    console.error("complete-switch-units failed:", e);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
