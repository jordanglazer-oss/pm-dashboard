import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimHolding, PimModelData } from "@/app/lib/pim-types";

const PIM_KEY = "pm:pim-models";
const CLASSES: PimHolding["assetClass"][] = ["equity", "fixedIncome", "alternative"];

/**
 * GET /api/admin/model-weight-audit
 *
 * READ-ONLY. Reports every (group, asset class) whose `weightInClass` values
 * do not sum to 100%, with the individual holdings, so a broken sleeve can be
 * seen rather than inferred from a Buy/Sell abort message.
 *
 * Written after a trade was blocked by "Non-Res fixedIncome weights sum to
 * 150.00%": the abort guard names the group and the class but not WHICH
 * holdings are wrong, which is the thing needed to fix it. Duplicate symbols
 * are called out separately, since a sleeve summing to exactly 150% with two
 * copies of the same fund is the signature of a double-add rather than of
 * drift.
 *
 * Writes nothing. Repair stays a separate, explicit action.
 */
export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(PIM_KEY);
    if (!raw) return NextResponse.json({ ok: true, groups: [], note: "pm:pim-models is empty" });
    const pim = JSON.parse(raw) as PimModelData;

    const problems: unknown[] = [];
    const summary: unknown[] = [];

    for (const g of pim.groups ?? []) {
      for (const ac of CLASSES) {
        const inClass = (g.holdings ?? []).filter((h) => h.assetClass === ac);
        if (inClass.length === 0) continue;
        const sum = inClass.reduce((s, h) => s + (h.weightInClass || 0), 0);
        const off = Math.abs(sum - 1) > 0.005;

        // A sleeve at exactly 150% with a repeated symbol is a double-add, not
        // drift — worth distinguishing because the repair differs.
        const seen = new Map<string, number>();
        for (const h of inClass) seen.set(h.symbol, (seen.get(h.symbol) ?? 0) + 1);
        const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([sym, n]) => ({ symbol: sym, count: n }));

        summary.push({ group: g.name, groupId: g.id, assetClass: ac, sumPct: +(sum * 100).toFixed(4), holdings: inClass.length, ok: !off });
        if (off || duplicates.length) {
          problems.push({
            group: g.name,
            groupId: g.id,
            assetClass: ac,
            sumPct: +(sum * 100).toFixed(4),
            excessPct: +((sum - 1) * 100).toFixed(4),
            duplicates,
            holdings: inClass.map((h) => ({
              symbol: h.symbol,
              name: h.name,
              currency: h.currency,
              weightInClassPct: +((h.weightInClass || 0) * 100).toFixed(4),
            })),
          });
        }
      }
    }

    return NextResponse.json({
      ok: problems.length === 0,
      problemCount: problems.length,
      problems,
      summary,
    });
  } catch (e) {
    console.error("model-weight-audit failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
