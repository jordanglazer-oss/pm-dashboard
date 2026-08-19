/**
 * GET /api/admin/repair-orphan-switch?sell=GRNJ&buy=LITE[&groups=...][&fraction=...][&confirm=YES]
 *
 * Repairs the model side of a PARTIAL sell-to-fund-a-buy, which the Buy/Sell
 * executor deliberately skips (see PimPortfolio executeTrade: the atomic swap
 * is gated on `!isPartialSell`). When the bought name is not already a model
 * holding, that skip produces an ORPHAN: real units in pm:pim-positions with
 * no holding in pm:pim-models. The Positioning table iterates MODEL holdings,
 * so the position is not merely mis-weighted — it is invisible, and its value
 * is missing from the denominator every other weight is computed against.
 *
 * What it does, per affected group:
 *   1. sold.weightInClass *= (1 - fraction)      — the trim, explicitly
 *   2. adds the bought holding if absent
 *   3. re-applies the live weighting rule (individual stocks equal-weight the
 *      residual; Core ETFs and Alpha funds keep their set weights), so the
 *      equity class still sums to 100% BY CONSTRUCTION rather than by luck.
 *
 * DRY-RUN BY DEFAULT. Without ?confirm=YES it computes the full before/after
 * diff and writes nothing. With it, both mutated keys are stashed first to
 * pm:<key>.pre-orphan-repair-<ISO> (auto-pruned at 14 days by the nightly
 * cron via stash-prune.ts), so the operation is reversible.
 *
 * Affected groups are DERIVED, not assumed:
 *   groups holding `sell`  ∩  `buy`'s modelEligibility from pm:stocks  −  groups already holding `buy`
 * The eligibility map is the ticket's own record of which models were checked
 * at execution time (persisted by addStock/updateStockFields whenever any
 * model was unchecked — which a USD buy always triggers via the No-US-Situs
 * auto-rule). An explicit &groups= overrides the derivation.
 *
 * The sell fraction is likewise DERIVED from the pre-trade snapshot
 * (before-vs-after units) rather than recalled, and is required to agree
 * across every profile before it is trusted.
 *
 * ABORTS AND WRITES NOTHING if any touched group's asset-class sum would end
 * up off 100%, or worse than it started.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const LEGACY_LOCKED_EQUITY_SYMBOLS = new Set(["FID5982", "FID5982-T", "GRNJ"]);
const SNAPSHOT_PREFIX = "pm:pre-trade-snapshot:";
const TOL = 0.005;

type Holding = {
  symbol: string; name?: string; currency?: "CAD" | "USD";
  assetClass?: "equity" | "fixedIncome" | "alternative";
  weightInClass: number; [k: string]: unknown;
};
type Group = { id: string; name: string; holdings: Holding[]; [k: string]: unknown };
type PimModelData = { groups?: Group[]; lastUpdated?: string; [k: string]: unknown };

type Position = { symbol: string; units: number; costBasis: number };
type Portfolio = { groupId: string; profile: string; positions?: Position[]; [k: string]: unknown };
type Positions = { portfolios?: Portfolio[] };

type Stock = {
  ticker: string; name?: string; bucket?: string;
  designation?: "core" | "alpha"; instrumentType?: string;
  modelEligibility?: Record<string, boolean>; [k: string]: unknown;
};

const norm = (s: string) => (s || "").toUpperCase().replace(/-T$/, ".TO");
const eq = (a: string | undefined, b: string) => !!a && norm(a) === norm(b);

function parseStocks(raw: string | null): Stock[] {
  if (!raw) return [];
  const p = JSON.parse(raw);
  if (Array.isArray(p)) return p as Stock[];
  if (p && Array.isArray(p.stocks)) return p.stocks as Stock[];
  return [];
}

async function scanAll(redis: Awaited<ReturnType<typeof getRedis>>, match: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

/**
 * Re-apply the live equity weighting rule to one group's holdings.
 *
 * Mirrors rebalanceStockWeights in StockContext: individual stocks equal-weight
 * whatever residual is left after Core ETFs and Alpha funds keep their set
 * weights. Deliberately a fresh implementation of the SAME rule rather than a
 * call into client code — but it must stay in step with it, so any change to
 * the residual rule needs making in both places.
 */
function applyWeightRule(
  holdings: Holding[],
  isStockSymbol: (sym: string) => boolean,
  isAlphaLocked: (sym: string) => boolean,
): Holding[] {
  const equity = holdings.filter((h) => h.assetClass === "equity");
  const nonEquity = holdings.filter((h) => h.assetClass !== "equity");
  if (equity.length === 0) return holdings;

  const stocks = equity.filter((h) => isStockSymbol(h.symbol));
  const locked = equity.filter((h) => !isStockSymbol(h.symbol) && isAlphaLocked(h.symbol));
  const core = equity.filter((h) => !isStockSymbol(h.symbol) && !isAlphaLocked(h.symbol));

  const lockedTotal = locked.reduce((s, h) => s + h.weightInClass, 0);
  const coreTotal = core.reduce((s, h) => s + h.weightInClass, 0);

  if (stocks.length > 0) {
    const residual = Math.max(0, 1.0 - coreTotal - lockedTotal);
    const perStock = parseFloat((residual / stocks.length).toFixed(6));
    return [
      ...nonEquity,
      ...locked,
      ...core,
      ...stocks.map((h) => ({ ...h, weightInClass: perStock })),
    ];
  }
  // No individual stocks to absorb the residual — Core ETFs take it
  // proportionally, so the class still sums to 100%.
  const residual = Math.max(0, 1.0 - lockedTotal);
  if (core.length === 0 || coreTotal <= 0) return holdings;
  return [
    ...nonEquity,
    ...locked,
    ...core.map((h) => ({
      ...h,
      weightInClass: parseFloat(((h.weightInClass / coreTotal) * residual).toFixed(6)),
    })),
  ];
}

const classSum = (hs: Holding[], ac: string) => {
  const inClass = hs.filter((h) => h.assetClass === ac);
  return inClass.length === 0 ? null : inClass.reduce((s, h) => s + h.weightInClass, 0);
};

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const sell = (searchParams.get("sell") || "").trim().toUpperCase();
    const buy = (searchParams.get("buy") || "").trim().toUpperCase();
    const confirm = searchParams.get("confirm") === "YES";
    const groupsParam = searchParams.get("groups");
    const fractionParam = searchParams.get("fraction");

    if (!sell || !buy) {
      return NextResponse.json({ error: "sell and buy query params are required" }, { status: 400 });
    }

    const redis = await getRedis();
    const [pimRaw, posRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:stocks"),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models missing" }, { status: 500 });

    const pim: PimModelData = JSON.parse(pimRaw);
    const pos: Positions = posRaw ? JSON.parse(posRaw) : {};
    const stocks: Stock[] = parseStocks(stocksRaw);
    const groups: Group[] = pim.groups ?? [];

    const notes: string[] = [];

    // ── Derive the sell fraction from the pre-trade snapshot ──────────────
    let fraction: number | null = null;
    let fractionSource = "";
    const perProfile: Array<{ groupId: string; profile: string; before: number; after: number; f: number }> = [];

    if (fractionParam) {
      const f = parseFloat(fractionParam);
      if (!Number.isFinite(f) || f <= 0 || f >= 1) {
        return NextResponse.json({ error: "fraction must be strictly between 0 and 1" }, { status: 400 });
      }
      fraction = f;
      fractionSource = "explicit &fraction= override";
    }

    const snapKeys = await scanAll(redis, `${SNAPSHOT_PREFIX}*`);
    const latestSnapKey = snapKeys.length > 0 ? [...snapKeys].sort().slice(-1)[0] : null;
    let snapMeta: { key: string; snapshotAt?: string; reason?: string } | null = null;
    if (latestSnapKey) {
      const snapRaw = await redis.get(latestSnapKey);
      if (snapRaw) {
        const snap = JSON.parse(snapRaw) as Record<string, unknown>;
        snapMeta = {
          key: latestSnapKey,
          snapshotAt: snap.snapshotAt as string | undefined,
          reason: snap.reason as string | undefined,
        };
        const rawPos = snap["pm:pim-positions"];
        if (typeof rawPos === "string") {
          const before: Positions = JSON.parse(rawPos);
          for (const bp of before.portfolios ?? []) {
            const b = (bp.positions ?? []).find((p) => eq(p.symbol, sell))?.units ?? 0;
            if (b <= 0) continue;
            const ap = (pos.portfolios ?? []).find(
              (p) => p.groupId === bp.groupId && p.profile === bp.profile,
            );
            const a = (ap?.positions ?? []).find((p) => eq(p.symbol, sell))?.units ?? 0;
            perProfile.push({ groupId: bp.groupId, profile: bp.profile, before: b, after: a, f: (b - a) / b });
          }
        }
      }
    }

    if (fraction == null && perProfile.length > 0) {
      const fs = perProfile.map((p) => p.f);
      const spread = Math.max(...fs) - Math.min(...fs);
      if (spread > 1e-6) {
        return NextResponse.json({
          error: "Sell fraction disagrees across profiles — refusing to guess. Pass &fraction= explicitly.",
          perProfile,
        }, { status: 400 });
      }
      fraction = fs[0];
      fractionSource = `derived from ${snapMeta?.key ?? "pre-trade snapshot"} (agrees across all ${fs.length} profiles)`;
    }

    if (fraction == null) {
      return NextResponse.json({
        error: `Could not derive the sell fraction for ${sell} from a pre-trade snapshot. Pass &fraction= explicitly (e.g. 0.25 for a 25% sell).`,
        latestPreTradeSnapshot: snapMeta,
      }, { status: 400 });
    }

    // ── Derive the affected groups ────────────────────────────────────────
    const buyStock = stocks.find((s) => eq(s.ticker, buy)) ?? null;
    const holdsSell = groups.filter((g) => g.holdings.some((h) => eq(h.symbol, sell)));
    const alreadyHoldsBuy = holdsSell.filter((g) => g.holdings.some((h) => eq(h.symbol, buy)));

    let candidates = holdsSell.filter((g) => !g.holdings.some((h) => eq(h.symbol, buy)));
    let groupSource = "";

    if (groupsParam) {
      const wanted = new Set(groupsParam.split(",").map((s) => s.trim()).filter(Boolean));
      candidates = candidates.filter((g) => wanted.has(g.id));
      groupSource = "explicit &groups= override";
    } else if (buyStock?.modelEligibility) {
      const elig = buyStock.modelEligibility;
      const excluded = candidates.filter((g) => elig[g.id] === false).map((g) => g.id);
      candidates = candidates.filter((g) => elig[g.id] !== false);
      groupSource = `${buy}.modelEligibility in pm:stocks (the ticket's own record of which models were checked)`;
      if (excluded.length > 0) notes.push(`Excluded by the ticket's eligibility map: ${excluded.join(", ")}.`);
    } else {
      groupSource = `all groups holding ${sell} (no modelEligibility recorded on ${buy})`;
      notes.push(
        `No modelEligibility found on ${buy} in pm:stocks, so which models you checked at execution time is NOT recorded. Defaulting to every group holding ${sell} — pass &groups= to narrow it.`,
      );
    }

    if (alreadyHoldsBuy.length > 0) {
      notes.push(`Already hold ${buy} (left alone): ${alreadyHoldsBuy.map((g) => g.name).join(", ")}.`);
    }
    if (candidates.length === 0) {
      return NextResponse.json({
        error: `No groups to repair. ${holdsSell.length} group(s) hold ${sell}; none are both eligible for ${buy} and missing it.`,
        notes,
      }, { status: 400 });
    }

    // ── Classification helpers, mirroring StockContext ────────────────────
    const stockEntries = new Map<string, Stock>();
    for (const s of stocks) if (s.ticker) stockEntries.set(norm(s.ticker), s);

    const isStockSymbol = (sym: string): boolean => {
      const e = stockEntries.get(norm(sym));
      if (e) return e.bucket === "Portfolio" && (e.instrumentType === "stock" || e.instrumentType === undefined);
      // No pm:stocks entry — not treatable as an individual stock.
      return false;
    };
    const isAlphaLocked = (sym: string): boolean => {
      const e = stockEntries.get(norm(sym));
      if (e) return e.designation !== "core";
      return LEGACY_LOCKED_EQUITY_SYMBOLS.has(sym.toUpperCase());
    };

    // Warn loudly if the bought name has no pm:stocks entry — without one it
    // is classified as a residual-absorbing Core ETF, which is wrong for a
    // stock and would quietly inflate it.
    if (!buyStock) {
      notes.push(
        `${buy} has NO pm:stocks entry. It would be treated as a residual-absorbing Core ETF by the weighting rule. This repair adds a Portfolio/alpha stock entry for it as part of the fix.`,
      );
    }

    const sellHoldingSample = holdsSell[0]?.holdings.find((h) => eq(h.symbol, sell));
    const buyCurrency: "CAD" | "USD" =
      buy.endsWith(".U") ? "USD"
        : (buy.endsWith("-T") || buy.endsWith(".TO") || buy.endsWith(".NE")) ? "CAD"
        : (sellHoldingSample?.currency ?? "USD");

    // The repaired pm:stocks (needed BEFORE weighting so isStockSymbol sees it).
    let nextStocks = stocks;
    if (!buyStock) {
      nextStocks = [
        ...stocks,
        {
          ticker: buy,
          name: buy,
          bucket: "Portfolio",
          instrumentType: "stock",
          designation: "alpha",
          sector: "",
          beta: 1.0,
          weights: { portfolio: 0 },
          scores: {},
          notes: "",
        } as Stock,
      ];
      stockEntries.set(norm(buy), nextStocks[nextStocks.length - 1]);
    }

    // ── Build the repaired groups ─────────────────────────────────────────
    const affected = new Set(candidates.map((g) => g.id));
    const diffs: Array<Record<string, unknown>> = [];

    const nextGroups: Group[] = groups.map((g) => {
      if (!affected.has(g.id)) return g;
      const before = g.holdings;
      const sold = before.find((h) => eq(h.symbol, sell))!;
      const trimmedWeight = sold.weightInClass * (1 - fraction!);

      const withTrim: Holding[] = before.map((h) =>
        eq(h.symbol, sell) ? { ...h, weightInClass: trimmedWeight } : h,
      );
      const withBuy: Holding[] = [
        ...withTrim,
        {
          name: (buyStock?.name || buy).toUpperCase(),
          symbol: buy,
          currency: buyCurrency,
          assetClass: sold.assetClass ?? "equity",
          weightInClass: 0,
        },
      ];
      const after = applyWeightRule(withBuy, isStockSymbol, isAlphaLocked);

      diffs.push({
        groupId: g.id,
        groupName: g.name,
        sellWeightBefore: sold.weightInClass,
        sellWeightAfter: trimmedWeight,
        buyWeightAfter: after.find((h) => eq(h.symbol, buy))?.weightInClass ?? 0,
        equitySumBefore: parseFloat(((classSum(before, "equity") ?? 0) * 100).toFixed(4)),
        equitySumAfter: parseFloat(((classSum(after, "equity") ?? 0) * 100).toFixed(4)),
        changedHoldings: after
          .filter((h) => {
            const b = before.find((x) => eq(x.symbol, h.symbol));
            return !b || Math.abs(b.weightInClass - h.weightInClass) > 1e-9;
          })
          .map((h) => {
            const b = before.find((x) => eq(x.symbol, h.symbol));
            return {
              symbol: h.symbol,
              before: b ? parseFloat((b.weightInClass * 100).toFixed(4)) : null,
              after: parseFloat((h.weightInClass * 100).toFixed(4)),
            };
          }),
      });

      return { ...g, holdings: after };
    });

    // ── Abort guard: no touched sleeve may end off 100%, or worse than it began.
    const ASSET_CLASSES = ["equity", "fixedIncome", "alternative"];
    const violations: string[] = [];
    for (const g of nextGroups) {
      if (!affected.has(g.id)) continue;
      const bg = groups.find((x) => x.id === g.id)!;
      for (const ac of ASSET_CLASSES) {
        const a = classSum(g.holdings, ac);
        if (a == null) continue;
        const b = classSum(bg.holdings, ac) ?? 1;
        const aOff = Math.abs(a - 1), bOff = Math.abs(b - 1);
        if (aOff > TOL && aOff > bOff + 1e-9) {
          violations.push(
            `${g.name} ${ac}: ${(b * 100).toFixed(2)}% → ${(a * 100).toFixed(2)}% (expected 100%)`,
          );
        }
      }
    }
    if (violations.length > 0) {
      return NextResponse.json({
        ok: false,
        aborted: true,
        error: "Repair would break an asset-class sum. NOTHING was written.",
        violations,
        diffs,
      }, { status: 400 });
    }

    const plan = {
      sell, buy, fraction, fractionSource,
      groupSource,
      affectedGroups: candidates.map((g) => ({ id: g.id, name: g.name })),
      addsStockEntry: !buyStock,
      latestPreTradeSnapshot: snapMeta,
      perProfileUnitsUsedForFraction: perProfile,
      notes,
      diffs,
    };

    if (!confirm) {
      return NextResponse.json({
        ok: true,
        dryRun: true,
        message: "DRY RUN — nothing written. Re-run with &confirm=YES to apply.",
        ...plan,
      });
    }

    // ── Write: stash both keys first, then read-modify-write ──────────────
    const stamp = new Date().toISOString();
    await redis.set(`pm:pim-models.pre-orphan-repair-${stamp}`, pimRaw);
    if (stocksRaw) await redis.set(`pm:stocks.pre-orphan-repair-${stamp}`, stocksRaw);

    const nextPim: PimModelData = { ...pim, groups: nextGroups, lastUpdated: stamp };
    await redis.set("pm:pim-models", JSON.stringify(nextPim));
    if (!buyStock) await redis.set("pm:stocks", JSON.stringify(nextStocks));

    return NextResponse.json({
      ok: true,
      dryRun: false,
      message: `Repaired ${candidates.length} model group(s).`,
      stashedTo: [
        `pm:pim-models.pre-orphan-repair-${stamp}`,
        ...(buyStock ? [] : [`pm:stocks.pre-orphan-repair-${stamp}`]),
      ],
      ...plan,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "repair-orphan-switch failed" },
      { status: 500 },
    );
  }
}
