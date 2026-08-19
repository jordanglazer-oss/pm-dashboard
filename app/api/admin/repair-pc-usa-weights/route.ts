/**
 * GET /api/admin/repair-pc-usa-weights[&confirm=YES]
 *
 * Restores PC USA's equity weights to the state its own design determines:
 * every individual stock — CAD and USD alike — at the standard per-stock
 * weight, with the Core ETF absorbing whatever is left.
 *
 * WHY THIS IS THE END STATE, not a guess. With 7 CAD stocks, 12 USD stocks,
 * GRNJ at 3.1818% and VTWO at 5.4545%, pinning stocks at 0.018182 leaves ITOT
 * at 0.568179 — the seed's 0.568182. Expressed against the currency splits
 * that fall out of it:
 *
 *   CAD sub-portfolio = 7 x 1.20% = 8.400% of total   (cadSplit 0.084)
 *   ITOT Target 37.50% / usdSplit 0.916 = 40.94%      (the number actually typed)
 *
 * Both land on their declared values without being forced there, which is what
 * makes this the model's intended shape rather than one reading of it.
 *
 * WHAT WENT WRONG. rebalanceStockWeights runs the branch where Core ETFs hold
 * a fixed weight and the individual stocks flex to absorb the residual. PC USA
 * needs the opposite — stocks fixed, Core absorbing — because ITOT's Target Wt
 * is meant to be DERIVED. With ITOT's manual 40.94% taken as a share of the
 * whole model instead of the USD one, it sat at 62.03% of the class and all 19
 * stocks gave up the difference, collapsing onto 1.5286%.
 *
 * SCOPE. PC USA only. No other model is read or written.
 *
 * DRY-RUN BY DEFAULT. ?confirm=YES stashes pm:pim-models to
 * pm:pim-models.pre-pcusa-repair-<ISO> first. Aborts without writing unless
 * every asset class lands on 100%.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const GROUP_ID = "pc-usa";
const REF_PER_STOCK = 0.018182;
const LEGACY_LOCKED = new Set(["FID5982", "FID5982-T", "GRNJ"]);
const TOL = 0.0005;

type Holding = {
  symbol: string; name?: string; currency?: "CAD" | "USD";
  assetClass?: "equity" | "fixedIncome" | "alternative";
  weightInClass: number; [k: string]: unknown;
};
type Group = {
  id: string; name: string; holdings: Holding[];
  cadSplit?: number; usdSplit?: number;
  profiles?: Record<string, { equity?: number } | undefined>; [k: string]: unknown;
};
type PimModelData = { groups?: Group[]; [k: string]: unknown };
type Stock = { ticker: string; bucket?: string; designation?: "core" | "alpha"; instrumentType?: string };

const norm = (s: string) => (s || "").toUpperCase().replace(/-T$/, ".TO");
const r4 = (n: number) => parseFloat((n * 100).toFixed(4));

function parseStocks(raw: string | null): Stock[] {
  if (!raw) return [];
  const p = JSON.parse(raw);
  if (Array.isArray(p)) return p as Stock[];
  if (p && Array.isArray(p.stocks)) return p.stocks as Stock[];
  return [];
}

export async function GET(req: NextRequest) {
  try {
    const confirm = new URL(req.url).searchParams.get("confirm") === "YES";
    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models missing" }, { status: 500 });

    const pim: PimModelData = JSON.parse(pimRaw);
    const group = (pim.groups ?? []).find((g) => g.id === GROUP_ID);
    if (!group) return NextResponse.json({ error: "pc-usa not found" }, { status: 404 });

    const stocks = parseStocks(stocksRaw);
    const byTicker = new Map<string, Stock>();
    for (const s of stocks) if (s.ticker) byTicker.set(norm(s.ticker), s);

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

    const equity = group.holdings.filter((h) => h.assetClass === "equity");
    const other = group.holdings.filter((h) => h.assetClass !== "equity");

    const stockHoldings = equity.filter((h) => isIndividualStock(h.symbol));
    const nonStock = equity.filter((h) => !isIndividualStock(h.symbol));
    const alphaFunds = nonStock.filter((h) => isAlphaLocked(h.symbol));
    const coreEtfs = nonStock.filter((h) => !isAlphaLocked(h.symbol));

    if (stockHoldings.length === 0 || coreEtfs.length === 0) {
      return NextResponse.json({
        ok: false, aborted: true,
        error: "PC USA needs both individual stocks and at least one Core ETF for this rule. Nothing written.",
        stockCount: stockHoldings.length, coreCount: coreEtfs.length,
      }, { status: 400 });
    }

    const stockTotal = REF_PER_STOCK * stockHoldings.length;
    const alphaTotal = alphaFunds.reduce((s, h) => s + h.weightInClass, 0);
    const coreResidual = 1 - stockTotal - alphaTotal;
    if (coreResidual <= 0) {
      return NextResponse.json({
        ok: false, aborted: true,
        error: `Stocks (${r4(stockTotal)}%) plus Alpha funds (${r4(alphaTotal)}%) already fill or exceed the equity class — no residual for the Core ETF. Nothing written.`,
      }, { status: 400 });
    }

    // Core ETFs share the residual in proportion to their current weights.
    const coreCurrentTotal = coreEtfs.reduce((s, h) => s + h.weightInClass, 0);
    const nextEquity: Holding[] = [
      ...stockHoldings.map((h) => ({ ...h, weightInClass: REF_PER_STOCK })),
      ...alphaFunds,
      ...coreEtfs.map((h) => ({
        ...h,
        weightInClass: parseFloat((
          coreCurrentTotal > 0
            ? (h.weightInClass / coreCurrentTotal) * coreResidual
            : coreResidual / coreEtfs.length
        ).toFixed(6)),
      })),
    ];

    const nextHoldings = [...other, ...nextEquity];

    // Guard every asset class, not just equity.
    const classes = ["equity", "fixedIncome", "alternative"] as const;
    const violations: string[] = [];
    for (const ac of classes) {
      const inClass = nextHoldings.filter((h) => h.assetClass === ac);
      if (inClass.length === 0) continue;
      const sum = inClass.reduce((s, h) => s + h.weightInClass, 0);
      if (Math.abs(sum - 1) > TOL) violations.push(`${ac} would land at ${(sum * 100).toFixed(4)}%`);
    }
    if (violations.length > 0) {
      return NextResponse.json({
        ok: false, aborted: true,
        error: `Refusing: ${violations.join("; ")}. Expected 100%. Nothing written.`,
      }, { status: 400 });
    }

    const eqAlloc = group.profiles?.balanced?.equity ?? 0.66;
    const changed = nextHoldings
      .map((h) => {
        const b = group.holdings.find((x) => norm(x.symbol) === norm(h.symbol));
        if (!b || Math.abs(b.weightInClass - h.weightInClass) < 1e-9) return null;
        return {
          symbol: h.symbol,
          currency: h.currency,
          role: isIndividualStock(h.symbol) ? "stock" : isAlphaLocked(h.symbol) ? "alpha" : "core",
          beforeWeightInClass: r4(b.weightInClass),
          afterWeightInClass: r4(h.weightInClass),
          beforeTargetWtPct: r4(b.weightInClass * eqAlloc),
          afterTargetWtPct: r4(h.weightInClass * eqAlloc),
        };
      })
      .filter(Boolean);

    const cadStockCount = stockHoldings.filter((h) => h.currency !== "USD").length;
    const plan = {
      groupId: GROUP_ID,
      rule: "individual stocks pinned at refPerStock; Alpha funds unchanged; Core ETF absorbs the residual",
      stockCount: stockHoldings.length,
      perStockWeightInClass: REF_PER_STOCK,
      perStockTargetWtPct: r4(REF_PER_STOCK * eqAlloc),
      alphaFunds: alphaFunds.map((h) => ({ symbol: h.symbol, weightInClass: r4(h.weightInClass) })),
      coreResidualWeightInClass: r4(coreResidual),
      coreTargetWtPct: r4(coreResidual * eqAlloc),
      crossChecks: {
        cadSubPortfolioPctOfTotal: r4(cadStockCount * REF_PER_STOCK * eqAlloc),
        declaredCadSplitPct: group.cadSplit != null ? r4(group.cadSplit) : null,
        coreUsdModelPct: group.usdSplit ? r4(coreResidual * eqAlloc / group.usdSplit) : null,
        note: "cadSubPortfolio should match declaredCadSplit, and coreUsdModel should match the manual weight typed for the Core ETF.",
      },
      changed,
    };

    if (!confirm) {
      return NextResponse.json({ ok: true, dryRun: true, message: "DRY RUN — nothing written. Re-run with &confirm=YES to apply.", ...plan });
    }

    const stamp = new Date().toISOString();
    await redis.set(`pm:pim-models.pre-pcusa-repair-${stamp}`, pimRaw);
    const nextPim: PimModelData = {
      ...pim,
      groups: (pim.groups ?? []).map((g) => (g.id === GROUP_ID ? { ...g, holdings: nextHoldings } : g)),
      lastUpdated: stamp,
    };
    await redis.set("pm:pim-models", JSON.stringify(nextPim));

    return NextResponse.json({
      ok: true, dryRun: false,
      message: "PC USA equity weights repaired.",
      stashedTo: `pm:pim-models.pre-pcusa-repair-${stamp}`,
      ...plan,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "repair-pc-usa-weights failed" }, { status: 500 });
  }
}
