/**
 * GET /api/admin/repair-currency-sleeves?group=pc-usa[&confirm=YES]
 *
 * Rewrites one group's live equity weights under the currency-sleeve rule that
 * rebalanceStockWeights now applies to PC USA: the equity class is split into a
 * CAD and a USD sleeve, and within each, fixed holdings (Core ETFs / Alpha
 * funds) keep their set weights while individual stocks equal-weight what is
 * left of that sleeve's target.
 *
 * WHY A REPAIR IS NEEDED. The code change only takes effect the next time a
 * rebalance is triggered for the group (a holding added, removed, or a manual
 * weight edited). Until then the stored weights keep the currency-blind values.
 * This applies the rule once, now.
 *
 * SCOPE. Refuses any group not in ALLOWED. Extending it means auditing that
 * group first — GET /api/admin/currency-sleeve-audit — because forcing declared
 * splits elsewhere moves weights in four models and destroys No US Situs.
 *
 * BASIS. PC USA stores cadSplit as a share of the TOTAL portfolio (0.084) while
 * every other group stores a share of the EQUITY CLASS. Divided by the balanced
 * equity allocation: 0.084 / 0.66 = 0.127273, matching the seed's CAD sleeve.
 *
 * DRY-RUN BY DEFAULT. ?confirm=YES stashes pm:pim-models to
 * pm:pim-models.pre-sleeve-repair-<ISO> first. Aborts without writing if the
 * result would not sum to 100%.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { pimModelSeed } from "@/app/lib/pim-seed";

const ALLOWED = new Set(["pc-usa"]);
const LEGACY_LOCKED = new Set(["FID5982", "FID5982-T", "GRNJ"]);
const TOL = 0.0005;

type Holding = {
  symbol: string; name?: string; currency?: "CAD" | "USD";
  assetClass?: "equity" | "fixedIncome" | "alternative";
  weightInClass: number; [k: string]: unknown;
};
type Group = {
  id: string; name: string; holdings: Holding[];
  cadSplit?: number; profiles?: Record<string, { equity?: number } | undefined>;
  [k: string]: unknown;
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
    const groupId = (searchParams.get("group") || "pc-usa").trim();
    const confirm = searchParams.get("confirm") === "YES";

    if (!ALLOWED.has(groupId)) {
      return NextResponse.json({
        error: `Refusing: "${groupId}" is not enabled for currency-sleeve weighting. Only ${[...ALLOWED].join(", ")}. Audit a group via /api/admin/currency-sleeve-audit before adding it.`,
      }, { status: 400 });
    }

    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models missing" }, { status: 500 });

    const pim: PimModelData = JSON.parse(pimRaw);
    const stocks = parseStocks(stocksRaw);
    const group = (pim.groups ?? []).find((g) => g.id === groupId);
    if (!group) return NextResponse.json({ error: `group ${groupId} not found` }, { status: 404 });

    // Sleeve target comes from the BASELINE seed, matching what
    // rebalanceStockWeights reads, so code and repair cannot disagree.
    const baseGroup = pimModelSeed.find((g) => g.id === groupId);
    const declaredCadSplit = baseGroup?.cadSplit;
    const equityAlloc = baseGroup?.profiles?.balanced?.equity;
    if (declaredCadSplit == null || !equityAlloc) {
      return NextResponse.json({ error: `baseline for ${groupId} lacks cadSplit or balanced equity allocation` }, { status: 500 });
    }
    const cadTarget = declaredCadSplit / equityAlloc;
    const usdTarget = 1 - cadTarget;

    const byTicker = new Map<string, Stock>();
    for (const s of stocks) if (s.ticker) byTicker.set(norm(s.ticker), s);
    const isIndividualStock = (sym: string) => {
      const e = byTicker.get(norm(sym));
      return !!e && e.bucket === "Portfolio" &&
        (e.instrumentType === "stock" || e.instrumentType === undefined);
    };
    const roleOf = (sym: string) => {
      const e = byTicker.get(norm(sym));
      if (e) return e.designation === "core" ? "core" : "alpha";
      return LEGACY_LOCKED.has(sym.toUpperCase()) ? "alpha" : "core";
    };

    const equity = group.holdings.filter((h) => h.assetClass === "equity");
    const nonEquity = group.holdings.filter((h) => h.assetClass !== "equity");

    const weightSleeve = (members: Holding[], target: number) => {
      const stocksIn = members.filter((h) => isIndividualStock(h.symbol));
      const fixed = members.filter((h) => !isIndividualStock(h.symbol));
      const fixedTotal = fixed.reduce((s, h) => s + h.weightInClass, 0);
      if (stocksIn.length === 0 || fixedTotal > target) return null;
      const per = parseFloat(((target - fixedTotal) / stocksIn.length).toFixed(6));
      return {
        holdings: [...fixed, ...stocksIn.map((h) => ({ ...h, weightInClass: per }))],
        target: r4(target),
        fixed: fixed.map((h) => ({ symbol: h.symbol, weight: r4(h.weightInClass), role: roleOf(h.symbol) })),
        fixedTotal: r4(fixedTotal),
        stockCount: stocksIn.length,
        perStock: r4(per),
      };
    };

    const cad = weightSleeve(equity.filter((h) => h.currency !== "USD"), cadTarget);
    const usd = weightSleeve(equity.filter((h) => h.currency === "USD"), usdTarget);
    if (!cad || !usd) {
      return NextResponse.json({
        ok: false, aborted: true,
        error: "A sleeve has no individual stocks to absorb its residual, or its fixed holdings already exceed the target. Nothing written.",
        cadFeasible: !!cad, usdFeasible: !!usd, cadTarget: r4(cadTarget), usdTarget: r4(usdTarget),
      }, { status: 400 });
    }

    const nextHoldings = [...nonEquity, ...cad.holdings, ...usd.holdings];
    const equitySum = [...cad.holdings, ...usd.holdings].reduce((s, h) => s + h.weightInClass, 0);
    if (Math.abs(equitySum - 1) > TOL) {
      return NextResponse.json({
        ok: false, aborted: true,
        error: `Result would leave the equity class at ${(equitySum * 100).toFixed(4)}% (expected 100%). Nothing written.`,
      }, { status: 400 });
    }

    const changed = nextHoldings
      .filter((h) => {
        const b = group.holdings.find((x) => norm(x.symbol) === norm(h.symbol));
        return !b || Math.abs(b.weightInClass - h.weightInClass) > 1e-9;
      })
      .map((h) => {
        const b = group.holdings.find((x) => norm(x.symbol) === norm(h.symbol))!;
        return {
          symbol: h.symbol,
          currency: h.currency,
          before: r4(b.weightInClass),
          after: r4(h.weightInClass),
          delta: r4(h.weightInClass - b.weightInClass),
        };
      });

    const plan = {
      groupId, groupName: group.name,
      basis: `cadSplit ${declaredCadSplit} / balanced equity ${equityAlloc} = ${r4(cadTarget)}% of the equity class`,
      cadSleeve: { target: cad.target, fixed: cad.fixed, fixedTotal: cad.fixedTotal, stockCount: cad.stockCount, perStock: cad.perStock },
      usdSleeve: { target: usd.target, fixed: usd.fixed, fixedTotal: usd.fixedTotal, stockCount: usd.stockCount, perStock: usd.perStock },
      equitySumAfter: r4(equitySum),
      changed,
    };

    if (!confirm) {
      return NextResponse.json({ ok: true, dryRun: true, message: "DRY RUN — nothing written. Re-run with &confirm=YES to apply.", ...plan });
    }

    const stamp = new Date().toISOString();
    await redis.set(`pm:pim-models.pre-sleeve-repair-${stamp}`, pimRaw);
    const nextPim: PimModelData = {
      ...pim,
      groups: (pim.groups ?? []).map((g) => (g.id === groupId ? { ...g, holdings: nextHoldings } : g)),
      lastUpdated: stamp,
    };
    await redis.set("pm:pim-models", JSON.stringify(nextPim));

    return NextResponse.json({
      ok: true, dryRun: false,
      message: `Rewrote ${group.name} equity weights under the currency-sleeve rule.`,
      stashedTo: `pm:pim-models.pre-sleeve-repair-${stamp}`,
      ...plan,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "repair-currency-sleeves failed" }, { status: 500 });
  }
}
