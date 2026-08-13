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
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    // Optional: dump the actual holdings for specific symbols across every
    // group, so a repair can be decided from the real weights rather than
    // inferred from class sums. e.g. ?symbols=TOU.TO,CCO.TO,JBND,JBND-T
    const symbolsParam = (url.searchParams.get("symbols") || "").trim();
    const wanted = symbolsParam
      ? symbolsParam.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean)
      : [];
    const norm = (x: string) => x.toUpperCase().replace("-T", ".TO");
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

    // Per-symbol view: what each requested symbol weighs in each group, and
    // what the rest of its sleeve looks like around it.
    const symbolView = wanted.length
      ? (pim.groups ?? []).map((g) => {
          const hits = (g.holdings ?? []).filter((h) => wanted.some((w) => norm(w) === norm(h.symbol)));
          if (hits.length === 0) return null;
          const classes = [...new Set(hits.map((h) => h.assetClass))];
          return {
            group: g.name,
            groupId: g.id,
            matched: hits.map((h) => ({
              symbol: h.symbol,
              assetClass: h.assetClass,
              weightInClassPct: +((h.weightInClass || 0) * 100).toFixed(4),
            })),
            sleeves: classes.map((ac) => {
              const inClass = (g.holdings ?? []).filter((h) => h.assetClass === ac);
              return {
                assetClass: ac,
                sumPct: +(inClass.reduce((s, h) => s + (h.weightInClass || 0), 0) * 100).toFixed(4),
                count: inClass.length,
              };
            }),
          };
        }).filter(Boolean)
      : undefined;

    return NextResponse.json({
      ok: problems.length === 0,
      problemCount: problems.length,
      problems,
      symbolView,
      summary,
    });
  } catch (e) {
    console.error("model-weight-audit failed:", e);
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
