import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type {
  PimHolding,
  PimModelGroup,
  PimModelGroupState,
  PimPortfolioState,
  PimTransaction,
} from "@/app/lib/pim-types";
import type { Stock } from "@/app/lib/types";

const PIM_MODELS_KEY = "pm:pim-models";
const PIM_STATE_KEY = "pm:pim-portfolio-state";
const STOCKS_KEY = "pm:stocks";

/**
 * GET /api/admin/patch-stale-swap?sold=SATS&bought=BK&sellPrice=119.2168&buyPrice=134.6536
 *
 * Surgically repairs a buy/sell executed BEFORE the fix in commit 22c796c
 * (where Execute Switch wrote the transaction record to pm:pim-portfolio-state
 * but never updated pm:pim-models or demoted the sold ticker to Watchlist).
 *
 * What it does:
 *   1. pm:pim-models — finds every group holding `sold`, replaces that holding
 *      with `bought` at the same weightInClass + assetClass. Groups where
 *      `bought` is already present are skipped (cannot double-hold).
 *   2. pm:stocks — moves `sold` from Portfolio → Watchlist; ensures `bought`
 *      is present as Portfolio with company-name metadata if available.
 *   3. pm:pim-portfolio-state — for every affected group, inherits drift onto
 *      `bought`'s rebalance price by recovering the OLD `sold` rebalance price
 *      from yesterday's or today's pm:backup:YYYY-MM-DD blob. If no backup
 *      contains the pre-swap price, falls back to `rebalancePrice = buyPrice`
 *      (zero-drift) — the transaction log row is already accurate either way.
 *
 * Returns JSON describing exactly what changed so the operator can verify.
 *
 * Does NOT modify the existing transaction records. The Appendix is the
 * permanent audit trail and stays intact.
 *
 * Safe to re-run: if sold is already missing from pim-models (because a
 * previous run already patched it), step 1 simply reports no changes.
 */
export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const sold = (url.searchParams.get("sold") || "").trim().toUpperCase();
    const bought = (url.searchParams.get("bought") || "").trim().toUpperCase();
    const sellPrice = Number(url.searchParams.get("sellPrice"));
    const buyPrice = Number(url.searchParams.get("buyPrice"));

    if (!sold || !bought) {
      return NextResponse.json({ error: "sold and bought query params required" }, { status: 400 });
    }
    if (!isFinite(sellPrice) || sellPrice <= 0 || !isFinite(buyPrice) || buyPrice <= 0) {
      return NextResponse.json({ error: "sellPrice and buyPrice must be positive numbers" }, { status: 400 });
    }

    const tickerEq = (a: string, b: string) =>
      a === b || a.replace("-T", ".TO") === b.replace("-T", ".TO");

    const redis = await getRedis();

    // ── Load all three live blobs.
    const [pimRaw, stateRaw, stocksRaw] = await Promise.all([
      redis.get(PIM_MODELS_KEY),
      redis.get(PIM_STATE_KEY),
      redis.get(STOCKS_KEY),
    ]);
    if (!pimRaw) return NextResponse.json({ error: "pm:pim-models not found" }, { status: 404 });

    const pim = JSON.parse(pimRaw) as { groups: PimModelGroup[]; lastUpdated?: string };
    const state: PimPortfolioState = stateRaw
      ? JSON.parse(stateRaw)
      : { groupStates: [], lastUpdated: new Date().toISOString() };
    const stocks: Stock[] = stocksRaw ? JSON.parse(stocksRaw) : [];

    // ── Pull backups to recover the pre-swap rebalance price of `sold`.
    // Try TODAY's backup first (snapshots pre-swap state if the 06:00 UTC
    // cron ran before the swap), fall back to YESTERDAY's.
    const pad = (n: number) => n.toString().padStart(2, "0");
    const dateKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    const today = new Date();
    const yesterday = new Date(today.getTime() - 86400000);
    const backupKeys = [`pm:backup:${dateKey(today)}`, `pm:backup:${dateKey(yesterday)}`];
    const backupPricesByGroup: Record<string, number> = {};
    let backupSourceUsed: string | null = null;

    for (const bkKey of backupKeys) {
      const bkRaw = await redis.get(bkKey);
      if (!bkRaw) continue;
      try {
        const bk = JSON.parse(bkRaw) as { data?: Record<string, string> };
        const snapStateRaw = bk.data?.[PIM_STATE_KEY];
        if (!snapStateRaw) continue;
        const snapState = JSON.parse(snapStateRaw) as PimPortfolioState;
        let foundAny = false;
        for (const gs of snapState.groupStates || []) {
          const price = gs.lastRebalance?.prices?.[sold];
          if (typeof price === "number" && price > 0) {
            if (!(gs.groupId in backupPricesByGroup)) {
              backupPricesByGroup[gs.groupId] = price;
              foundAny = true;
            }
          }
        }
        if (foundAny) {
          backupSourceUsed = bkKey;
          break; // prefer the first backup that has any data
        }
      } catch { /* ignore malformed backup */ }
    }

    // ── Step 1: swap plan for pm:pim-models.
    type Plan = { groupId: string; groupName: string; sold: PimHolding };
    const plan: Plan[] = [];
    const skipped: string[] = [];
    for (const g of pim.groups) {
      const soldHolding = g.holdings.find((h) => tickerEq(h.symbol, sold));
      if (!soldHolding) continue;
      const boughtAlready = g.holdings.some((h) => tickerEq(h.symbol, bought));
      if (boughtAlready) {
        skipped.push(g.name);
        continue;
      }
      plan.push({ groupId: g.id, groupName: g.name, sold: soldHolding });
    }

    // Detect bought currency (match handler logic).
    const fallbackCurrency = plan[0]?.sold.currency ?? "USD";
    const buyCurrency: "CAD" | "USD" =
      bought.endsWith(".U") ? "USD"
        : bought.endsWith("-T") || bought.endsWith(".TO") ? "CAD"
          : fallbackCurrency;

    // Try to resolve bought ticker's proper name via the same endpoint the
    // UI uses; non-fatal if unavailable.
    let boughtName = bought;
    try {
      const nameRes = await fetch(`${url.origin}/api/company-name?tickers=${encodeURIComponent(bought)}`);
      if (nameRes.ok) {
        const body = await nameRes.json();
        if (body.names?.[bought]) boughtName = body.names[bought];
      }
    } catch { /* ignore */ }

    // Apply the swap.
    const pimChanges: Array<{ groupId: string; groupName: string; weightInClass: number; assetClass: string }> = [];
    if (plan.length > 0) {
      pim.groups = pim.groups.map((g) => {
        const p = plan.find((x) => x.groupId === g.id);
        if (!p) return g;
        return {
          ...g,
          holdings: g.holdings.map((h) =>
            h === p.sold
              ? {
                  name: boughtName.toUpperCase(),
                  symbol: bought,
                  currency: buyCurrency,
                  assetClass: p.sold.assetClass,
                  weightInClass: p.sold.weightInClass,
                }
              : h
          ),
        };
      });
      pim.lastUpdated = new Date().toISOString();
      for (const p of plan) {
        pimChanges.push({
          groupId: p.groupId,
          groupName: p.groupName,
          weightInClass: p.sold.weightInClass,
          assetClass: p.sold.assetClass,
        });
      }
    }

    // ── Step 2: pm:stocks — sold → Watchlist, ensure bought is Portfolio.
    let stocksChanged = false;
    const stocksPatched: string[] = [];
    const soldIdx = stocks.findIndex((s) => tickerEq(s.ticker, sold));
    if (soldIdx >= 0 && stocks[soldIdx].bucket === "Portfolio") {
      stocks[soldIdx] = { ...stocks[soldIdx], bucket: "Watchlist", weights: { portfolio: 0 } };
      stocksChanged = true;
      stocksPatched.push(`${sold}: Portfolio → Watchlist`);
    }
    const boughtIdx = stocks.findIndex((s) => tickerEq(s.ticker, bought));
    if (boughtIdx >= 0 && stocks[boughtIdx].bucket !== "Portfolio") {
      stocks[boughtIdx] = { ...stocks[boughtIdx], bucket: "Portfolio" };
      stocksChanged = true;
      stocksPatched.push(`${bought}: ${stocks[boughtIdx].bucket} → Portfolio`);
    }

    // ── Step 3: pm:pim-portfolio-state — inherit drift onto bought's
    // rebalance price in every affected group, using the backup-recovered
    // pre-swap price for sold.
    const stateChanges: Array<{
      groupId: string;
      oldBoughtRebalancePrice: number | null;
      newBoughtRebalancePrice: number;
      driftInherited: boolean;
      oldSellRebalancePriceFromBackup: number | null;
    }> = [];

    const nowIso = new Date().toISOString();
    for (const p of plan) {
      const gsIdx = state.groupStates.findIndex((gs) => gs.groupId === p.groupId);
      const existing: PimModelGroupState = gsIdx >= 0
        ? state.groupStates[gsIdx]
        : { groupId: p.groupId, lastRebalance: null, trackingStart: null, transactions: [] };

      const prices = { ...(existing.lastRebalance?.prices || {}) };
      const oldBoughtPrice = typeof prices[bought] === "number" ? prices[bought] : null;
      const oldSellFromBackup = backupPricesByGroup[p.groupId] ?? null;

      let newBoughtPrice: number;
      let driftInherited: boolean;
      if (oldSellFromBackup && oldSellFromBackup > 0 && sellPrice > 0) {
        newBoughtPrice = buyPrice * (oldSellFromBackup / sellPrice);
        driftInherited = true;
      } else {
        newBoughtPrice = buyPrice;
        driftInherited = false;
      }
      prices[bought] = newBoughtPrice;

      const patched: PimModelGroupState = {
        ...existing,
        lastRebalance: existing.lastRebalance
          ? { ...existing.lastRebalance, prices }
          : { date: nowIso, prices },
      };

      if (gsIdx >= 0) state.groupStates[gsIdx] = patched;
      else state.groupStates.push(patched);

      stateChanges.push({
        groupId: p.groupId,
        oldBoughtRebalancePrice: oldBoughtPrice,
        newBoughtRebalancePrice: parseFloat(newBoughtPrice.toFixed(4)),
        driftInherited,
        oldSellRebalancePriceFromBackup: oldSellFromBackup ? parseFloat(oldSellFromBackup.toFixed(4)) : null,
      });
    }
    state.lastUpdated = nowIso;

    // ── Write back.
    const writes: Promise<unknown>[] = [];
    if (pimChanges.length > 0) writes.push(redis.set(PIM_MODELS_KEY, JSON.stringify(pim)));
    if (stocksChanged) writes.push(redis.set(STOCKS_KEY, JSON.stringify(stocks)));
    if (stateChanges.length > 0) writes.push(redis.set(PIM_STATE_KEY, JSON.stringify(state)));
    await Promise.all(writes);

    // Verify transactions referencing the swap exist (for operator sanity).
    const txnMatches: Array<{ groupId: string; count: number }> = [];
    for (const gs of state.groupStates) {
      const count = gs.transactions.filter(
        (t: PimTransaction) =>
          (tickerEq(t.symbol, sold) || tickerEq(t.symbol, bought)) &&
          (t.pairedWith ? tickerEq(t.pairedWith, sold) || tickerEq(t.pairedWith, bought) : true)
      ).length;
      if (count > 0) txnMatches.push({ groupId: gs.groupId, count });
    }

    return NextResponse.json({
      ok: true,
      sold,
      bought,
      sellPrice,
      buyPrice,
      backupSourceUsed: backupSourceUsed ?? "none-available",
      pim: {
        groupsPatched: pimChanges.length,
        details: pimChanges,
        skippedBoughtAlreadyPresent: skipped,
      },
      stocks: {
        changed: stocksChanged,
        details: stocksPatched,
      },
      state: {
        groupsPatched: stateChanges.length,
        details: stateChanges,
      },
      existingTransactions: txnMatches,
      note:
        pimChanges.length === 0
          ? `${sold} was not found in any PIM group — either already patched or never there. Nothing to do.`
          : `Patched ${pimChanges.length} group(s). Reload the Positioning tab to see the change.`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
