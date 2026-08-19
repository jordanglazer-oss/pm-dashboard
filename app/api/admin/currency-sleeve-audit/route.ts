/**
 * GET /api/admin/currency-sleeve-audit
 *
 * READ-ONLY. Reports, per model group, how the live equity class actually
 * splits between its CAD and USD sleeves versus the split the group declares
 * via cadSplit / usdSplit — and what a currency-AWARE weighting rule would
 * produce.
 *
 * WHY. rebalanceStockWeights equal-weights every individual stock against ONE
 * residual, blind to currency. Any group whose CAD and USD sleeves are meant
 * to be different sizes therefore drifts: the freed weight from a USD holding
 * leaks into CAD stocks and vice versa. PC USA shows it worst, because its CAD
 * sleeve is Canadian stocks ONLY (no CAD ETFs), so every manual weight change
 * to a USD ETF (ITOT / VTWO / JBND / WTPI) silently repriced the Canadian
 * names.
 *
 * BASIS WARNING. In the seed, cadSplit is the CAD share of the EQUITY CLASS
 * for every group except PC USA, where the stored 0.084 is the share of the
 * TOTAL PORTFOLIO (0.084 / 0.66 balanced-equity = 0.1273, which matches its
 * actual CAD sleeve). This route reports both readings rather than picking
 * one, because the correct repair depends on which basis is intended.
 *
 * Writes nothing.
 */

import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

type Holding = {
  symbol: string; name?: string; currency?: "CAD" | "USD";
  assetClass?: "equity" | "fixedIncome" | "alternative";
  weightInClass: number;
};
type Profiles = Record<string, { equity?: number } | undefined>;
type Group = {
  id: string; name: string; holdings: Holding[];
  cadSplit?: number; usdSplit?: number; profiles?: Profiles;
};
type PimModelData = { groups?: Group[] };

type Stock = {
  ticker: string; bucket?: string;
  designation?: "core" | "alpha"; instrumentType?: string;
};

const LEGACY_LOCKED = new Set(["FID5982", "FID5982-T", "GRNJ"]);
const norm = (s: string) => (s || "").toUpperCase().replace(/-T$/, ".TO");

function parseStocks(raw: string | null): Stock[] {
  if (!raw) return [];
  const p = JSON.parse(raw);
  if (Array.isArray(p)) return p as Stock[];
  if (p && Array.isArray(p.stocks)) return p.stocks as Stock[];
  return [];
}

const r4 = (n: number) => parseFloat((n * 100).toFixed(4));

export async function GET() {
  try {
    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models missing" }, { status: 500 });

    const pim: PimModelData = JSON.parse(pimRaw);
    const stocks = parseStocks(stocksRaw);

    const byTicker = new Map<string, Stock>();
    for (const s of stocks) if (s.ticker) byTicker.set(norm(s.ticker), s);

    // Same classification the live weighting rule uses.
    const isIndividualStock = (sym: string) => {
      const e = byTicker.get(norm(sym));
      return !!e && e.bucket === "Portfolio" &&
        (e.instrumentType === "stock" || e.instrumentType === undefined);
    };
    const isAlphaLocked = (sym: string) => {
      const e = byTicker.get(norm(sym));
      if (e) return e.designation !== "core";
      return LEGACY_LOCKED.has(sym.toUpperCase());
    };

    const report = (pim.groups ?? []).map((g) => {
      const equity = (g.holdings ?? []).filter((h) => h.assetClass === "equity");
      const cad = equity.filter((h) => h.currency !== "USD");
      const usd = equity.filter((h) => h.currency === "USD");
      const cadActual = cad.reduce((s, h) => s + h.weightInClass, 0);
      const usdActual = usd.reduce((s, h) => s + h.weightInClass, 0);

      const equityAlloc = g.profiles?.balanced?.equity ?? null;
      const declared = g.cadSplit ?? null;
      // Two readings of the declared split, since the seed is inconsistent.
      const asClassShare = declared;
      const asPortfolioShare = declared != null && equityAlloc ? declared / equityAlloc : null;

      const classShareOff = asClassShare != null ? Math.abs(cadActual - asClassShare) : null;
      const portfolioShareOff = asPortfolioShare != null ? Math.abs(cadActual - asPortfolioShare) : null;
      const likelyBasis =
        classShareOff == null || portfolioShareOff == null ? "unknown"
          : classShareOff <= portfolioShareOff ? "share-of-equity-class" : "share-of-total-portfolio";

      // What a currency-aware rule would produce, using the reading that best
      // fits this group's own data. Within each sleeve: Core/Alpha keep their
      // set weights; individual stocks equal-weight the sleeve residual.
      const cadTarget = likelyBasis === "share-of-total-portfolio" ? asPortfolioShare! : (asClassShare ?? cadActual);
      const usdTarget = 1 - cadTarget;

      const sleeve = (hs: Holding[], target: number) => {
        const stocksIn = hs.filter((h) => isIndividualStock(h.symbol));
        const fixed = hs.filter((h) => !isIndividualStock(h.symbol));
        const fixedTotal = fixed.reduce((s, h) => s + h.weightInClass, 0);
        const residual = Math.max(0, target - fixedTotal);
        const perStock = stocksIn.length > 0 ? residual / stocksIn.length : 0;
        return {
          target: r4(target),
          fixedHoldings: fixed.map((h) => ({
            symbol: h.symbol,
            weight: r4(h.weightInClass),
            role: isAlphaLocked(h.symbol) ? "alpha" : "core",
          })),
          fixedTotal: r4(fixedTotal),
          stockCount: stocksIn.length,
          perStockNow: stocksIn.length > 0 ? r4(stocksIn[0].weightInClass) : null,
          perStockProposed: r4(perStock),
          stocks: stocksIn.map((h) => ({
            symbol: h.symbol,
            now: r4(h.weightInClass),
            proposed: r4(perStock),
            delta: r4(perStock - h.weightInClass),
          })),
        };
      };

      return {
        groupId: g.id,
        groupName: g.name,
        equityAlloc,
        declaredCadSplit: declared,
        declaredUsdSplit: g.usdSplit ?? null,
        actual: { cadSleeve: r4(cadActual), usdSleeve: r4(usdActual), total: r4(cadActual + usdActual) },
        readings: {
          ifShareOfEquityClass: asClassShare != null ? r4(asClassShare) : null,
          ifShareOfTotalPortfolio: asPortfolioShare != null ? r4(asPortfolioShare) : null,
          likelyBasis,
        },
        /** True when CAD and USD stocks are equal-weighted across the currency
         *  divide — the signature of the currency-blind residual rule. */
        currencyBlind:
          sleeve(cad, cadTarget).perStockNow != null &&
          sleeve(usd, usdTarget).perStockNow != null &&
          Math.abs((sleeve(cad, cadTarget).perStockNow ?? 0) - (sleeve(usd, usdTarget).perStockNow ?? 0)) < 0.0001,
        cad: sleeve(cad, cadTarget),
        usd: sleeve(usd, usdTarget),
      };
    });

    return NextResponse.json({ generatedAt: new Date().toISOString(), report });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "currency-sleeve-audit failed" },
      { status: 500 },
    );
  }
}
