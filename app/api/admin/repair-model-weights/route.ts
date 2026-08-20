/**
 * GET /api/admin/repair-model-weights?group=kpmg[&confirm=YES]
 *
 * Applies the standing weighting rule to one model group's live equity
 * weights: every individual stock at refPerStock, Alpha funds untouched, and
 * the Core ETFs absorbing whatever residual is left, in proportion to their
 * current weights.
 *
 * WHY A REPAIR IS NEEDED. rebalanceStockWeights only runs when something
 * triggers it — a holding added or removed, or a manual weight edited. A model
 * that drifted under the previous (inverse) rule keeps its stored weights until
 * something touches it. This applies the rule once, deliberately.
 *
 * The inverse rule — Core/Alpha fixed, stocks flexing to fill the residual —
 * is a no-op on balanced data, which is why it went unnoticed, but it made the
 * individual stocks pay for every other change in the model. Adding LITE to
 * KPMG pulled all 11 of its stocks from 1.20% to 1.09% of portfolio instead of
 * the Core sleeve funding the addition.
 *
 * ONE GROUP PER CALL, named explicitly — there is no "repair everything", so a
 * model cannot be rewritten by accident.
 *
 * DRY-RUN BY DEFAULT. ?confirm=YES stashes pm:pim-models to
 * pm:pim-models.pre-weight-repair-<ISO> first. Aborts without writing unless
 * EVERY asset class lands on 100%.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { pimModelSeed } from "@/app/lib/pim-seed";

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
    const { searchParams } = new URL(req.url);
    const groupId = (searchParams.get("group") || "").trim();
    const confirm = searchParams.get("confirm") === "YES";
    if (!groupId) {
      return NextResponse.json({ error: "group query param is required (e.g. ?group=kpmg)" }, { status: 400 });
    }

    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models missing" }, { status: 500 });

    const pim: PimModelData = JSON.parse(pimRaw);
    const group = (pim.groups ?? []).find((g) => g.id === groupId);
    if (!group) {
      return NextResponse.json({
        error: `group "${groupId}" not found`,
        available: (pim.groups ?? []).map((g) => g.id),
      }, { status: 404 });
    }

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
        error: "This rule needs both individual stocks and at least one Core ETF to absorb the residual. Nothing written.",
        stockCount: stockHoldings.length, coreCount: coreEtfs.length,
      }, { status: 400 });
    }

    const stockTotal = REF_PER_STOCK * stockHoldings.length;
    const alphaTotal = alphaFunds.reduce((s, h) => s + h.weightInClass, 0);
    const coreResidual = 1 - stockTotal - alphaTotal;
    if (coreResidual <= 0) {
      return NextResponse.json({
        ok: false, aborted: true,
        error: `Stocks (${r4(stockTotal)}%) plus Alpha funds (${r4(alphaTotal)}%) already fill the equity class — no residual left for the Core ETFs. Nothing written.`,
      }, { status: 400 });
    }

    // Core ETFs share the residual by their ratio within the PIM MODEL's Core
    // sleeve — not by this group's own live weights. The PIM model is the
    // target every other model is derived from, so a group's Core mix follows
    // it rather than whatever its stored weights happen to be. This matches
    // what rebalanceStockWeights does live, so the repair and the running code
    // cannot disagree.
    const pimBase = pimModelSeed.find((g) => g.id === "pim");
    const pimCoreRatio = new Map<string, number>();
    if (pimBase) {
      let pimCoreTotal = 0;
      for (const h of pimBase.holdings) {
        if (h.assetClass !== "equity") continue;
        if (!coreEtfs.some((c) => norm(c.symbol) === norm(h.symbol))) continue;
        pimCoreRatio.set(norm(h.symbol), h.weightInClass);
        pimCoreTotal += h.weightInClass;
      }
      if (pimCoreTotal > 0) {
        for (const [k, v] of pimCoreRatio) pimCoreRatio.set(k, v / pimCoreTotal);
      } else {
        pimCoreRatio.clear();
      }
    }
    // A Core ETF absent from the PIM model (e.g. PC USA's ITOT) has no PIM
    // ratio to follow; those fall back to their share of this group's own
    // Core sleeve so the residual is still fully distributed.
    const coreCurrentTotal = coreEtfs.reduce((s, h) => s + h.weightInClass, 0);
    const covered = coreEtfs.filter((h) => pimCoreRatio.has(norm(h.symbol)));
    const usePimRatios = covered.length === coreEtfs.length && pimCoreRatio.size > 0;

    const nextEquity: Holding[] = [
      ...stockHoldings.map((h) => ({ ...h, weightInClass: REF_PER_STOCK })),
      ...alphaFunds,
      ...coreEtfs.map((h) => {
        const ratio = usePimRatios
          ? pimCoreRatio.get(norm(h.symbol))!
          : coreCurrentTotal > 0
            ? h.weightInClass / coreCurrentTotal
            : 1 / coreEtfs.length;
        return { ...h, weightInClass: parseFloat((ratio * coreResidual).toFixed(6)) };
      }),
    ];
    const nextHoldings = [...other, ...nextEquity];

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
          role: isIndividualStock(h.symbol) ? "stock" : isAlphaLocked(h.symbol) ? "alpha" : "core",
          beforeTargetWtPct: r4(b.weightInClass * eqAlloc),
          afterTargetWtPct: r4(h.weightInClass * eqAlloc),
        };
      })
      .filter(Boolean);

    const plan = {
      groupId, groupName: group.name,
      rule: "individual stocks at refPerStock; Alpha funds unchanged; Core ETFs absorb the residual by their ratio in the PIM model",
      coreRatioSource: usePimRatios ? "PIM model target weights" : "this group's own Core weights (a Core ETF here is absent from the PIM model)",
      stockCount: stockHoldings.length,
      perStockTargetWtPct: r4(REF_PER_STOCK * eqAlloc),
      alphaFunds: alphaFunds.map((h) => ({ symbol: h.symbol, targetWtPct: r4(h.weightInClass * eqAlloc) })),
      coreResidualTargetWtPct: r4(coreResidual * eqAlloc),
      changed,
    };

    if (!confirm) {
      return NextResponse.json({ ok: true, dryRun: true, message: "DRY RUN — nothing written. Re-run with &confirm=YES to apply.", ...plan });
    }

    const stamp = new Date().toISOString();
    await redis.set(`pm:pim-models.pre-weight-repair-${stamp}`, pimRaw);
    const nextPim: PimModelData = {
      ...pim,
      groups: (pim.groups ?? []).map((g) => (g.id === groupId ? { ...g, holdings: nextHoldings } : g)),
      lastUpdated: stamp,
    };
    await redis.set("pm:pim-models", JSON.stringify(nextPim));

    return NextResponse.json({
      ok: true, dryRun: false,
      message: `${group.name} equity weights repaired.`,
      stashedTo: `pm:pim-models.pre-weight-repair-${stamp}`,
      ...plan,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "repair-model-weights failed" }, { status: 500 });
  }
}
