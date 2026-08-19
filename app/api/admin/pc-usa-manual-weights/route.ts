/**
 * GET /api/admin/pc-usa-manual-weights?group=pc-usa
 *
 * READ-ONLY. For every holding in one group, shows the manual weight the user
 * actually typed (pm:stocks modelWeights[groupId], falling back to
 * weights.portfolio) next to the weightInClass currently stored, and what that
 * typed number would produce under each of the two candidate formulas:
 *
 *   current:  weightInClass = (typed / 100) / balancedAlloc
 *   proposed: weightInClass = (typed / 100) * currencySplit / balancedAlloc
 *
 * WHY. PC USA is built as TWO sub-portfolios — a CAD one worth cadSplit of the
 * total and a USD one worth usdSplit — each internally summing to 100% across
 * ALL asset classes. A manual weight there is a weight within its currency's
 * sub-portfolio, so it must be scaled by that currency's split before it
 * becomes a share of the whole model. The current formula omits that factor,
 * which inflates every manually-weighted USD holding and forces the
 * equal-weighted stocks to give up the difference.
 *
 * This route does not decide anything — it shows which formula reproduces the
 * stored/seed values, so the repair is chosen from data rather than assumed.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

type Holding = {
  symbol: string; name?: string; currency?: "CAD" | "USD";
  assetClass?: "equity" | "fixedIncome" | "alternative"; weightInClass: number;
};
type Group = {
  id: string; name: string; holdings: Holding[];
  cadSplit?: number; usdSplit?: number;
  profiles?: Record<string, { equity?: number; fixedIncome?: number; alternatives?: number } | undefined>;
};
type Stock = {
  ticker: string; instrumentType?: string; bucket?: string;
  modelWeights?: Record<string, number>; weights?: { portfolio?: number };
};

const norm = (s: string) => (s || "").toUpperCase().replace(/-T$/, ".TO");
const r4 = (n: number) => parseFloat(n.toFixed(4));

function parseStocks(raw: string | null): Stock[] {
  if (!raw) return [];
  const p = JSON.parse(raw);
  if (Array.isArray(p)) return p as Stock[];
  if (p && Array.isArray(p.stocks)) return p.stocks as Stock[];
  return [];
}

export async function GET(req: NextRequest) {
  try {
    const groupId = (new URL(req.url).searchParams.get("group") || "pc-usa").trim();
    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models missing" }, { status: 500 });

    const pim = JSON.parse(pimRaw) as { groups?: Group[] };
    const group = (pim.groups ?? []).find((g) => g.id === groupId);
    if (!group) return NextResponse.json({ error: `group ${groupId} not found` }, { status: 404 });

    const stocks = parseStocks(stocksRaw);
    const byTicker = new Map<string, Stock>();
    for (const s of stocks) if (s.ticker) byTicker.set(norm(s.ticker), s);

    const bal = group.profiles?.balanced;
    const allocOf = (ac?: string) =>
      ac === "fixedIncome" ? bal?.fixedIncome ?? 0
        : ac === "alternative" ? bal?.alternatives ?? 0
        : bal?.equity ?? 0;

    const cadSplit = group.cadSplit ?? null;
    const usdSplit = group.usdSplit ?? null;

    const rows = group.holdings.map((h) => {
      const s = byTicker.get(norm(h.symbol));
      const isIndividualStock = !!s && s.bucket === "Portfolio" &&
        (s.instrumentType === "stock" || s.instrumentType === undefined);
      const typed = s?.modelWeights?.[groupId] ?? s?.weights?.portfolio ?? null;
      const alloc = allocOf(h.assetClass);
      const split = h.currency === "USD" ? usdSplit : cadSplit;

      const currentFormula = typed != null && alloc > 0 ? (typed / 100) / alloc : null;
      const proposedFormula = typed != null && alloc > 0 && split != null
        ? (typed / 100) * split / alloc : null;

      const storedTargetWt = h.weightInClass * alloc * 100;
      return {
        symbol: h.symbol,
        currency: h.currency,
        assetClass: h.assetClass,
        isIndividualStock,
        typedManualWeight: typed,
        storedWeightInClass: r4(h.weightInClass),
        storedTargetWtPct: r4(storedTargetWt),
        /** Each holding as a share of its own currency sub-portfolio. */
        subPortfolioWeightPct: split ? r4(storedTargetWt / split) : null,
        currentFormulaWeightInClass: currentFormula != null ? r4(currentFormula) : null,
        proposedFormulaWeightInClass: proposedFormula != null ? r4(proposedFormula) : null,
        matchesStored: currentFormula != null
          ? (Math.abs(currentFormula - h.weightInClass) < 0.0005 ? "current"
            : proposedFormula != null && Math.abs(proposedFormula - h.weightInClass) < 0.0005 ? "proposed"
            : "neither")
          : "no-typed-value",
      };
    });

    // Sub-portfolio totals: under the two-model reading each should sum to 100%.
    const sum = (ccy: "CAD" | "USD") => rows
      .filter((r) => (ccy === "USD" ? r.currency === "USD" : r.currency !== "USD"))
      .reduce((s, r) => s + (r.subPortfolioWeightPct ?? 0), 0);

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      groupId, groupName: group.name,
      cadSplit, usdSplit,
      balancedAllocations: bal ?? null,
      subPortfolioCheck: {
        cadSumsToPct: r4(sum("CAD")),
        usdSumsToPct: r4(sum("USD")),
        note: "Under the two-sub-portfolio reading each of these should be 100%.",
      },
      rows,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "pc-usa-manual-weights failed" }, { status: 500 });
  }
}
