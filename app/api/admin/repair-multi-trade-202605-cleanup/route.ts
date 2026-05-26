/**
 * POST /api/admin/repair-multi-trade-202605-cleanup?confirm=YES
 *
 * Second-pass surgical repair for damage caused by the original
 * /api/admin/repair-multi-trade-202605 endpoint.
 *
 * The original repair script assumed pm:stocks had shape
 *   { stocks: Stock[] }
 * and wrote back
 *   { ...stocksBlob, stocks: updatedStocks }
 *
 * but pm:stocks is actually stored as a BARE JSON ARRAY (see
 * app/api/kv/stocks/route.ts — PUT stores `JSON.stringify(stocks)`
 * directly). Spreading an array into an object literal converts the
 * array indices into object property names ("0", "1", ..., "N") and
 * the spread `stocks` field then sits alongside them. The frontend,
 * which iterates pm:stocks as an array, then misbehaves across the
 * Positioning tab, Refresh Prices button, and mutual fund
 * price/units handling.
 *
 * Two compounding issues:
 *   - Capstone (CS.TO) and Barrick (ABX.TO) were already in pm:stocks
 *     as Watchlist entries (indices 13 and 2 respectively) before
 *     today's trade. The buggy multi-trade Buy was supposed to flip
 *     their bucket from "Watchlist" to "Portfolio". Instead, the
 *     repair script appended NEW entries (one mislabeled "CELESTICA"),
 *     leaving the original Watchlist entries unchanged.
 *   - The repair script also added CS.TO to every group's holdings in
 *     pm:pim-models that had ABX.TO. KPMG and Deloitte models are not
 *     supposed to hold Capstone.
 *
 * This endpoint:
 *   1. Stashes the current contents of pm:stocks and pm:pim-models to
 *      pm:pre-repair-stash:{ISO timestamp} so this repair is itself
 *      reversible via /api/admin/undo-cleanup-repair.
 *   2. Rebuilds pm:stocks as a proper JSON array:
 *      - Takes values from numeric keys "0".."N" in numeric order.
 *      - Drops the malformed `stocks` field (the two appended,
 *        duplicate entries for ABX.TO and CS.TO are discarded; the
 *        canonical entries already exist in the numeric-keyed values
 *        with the correct names and full metadata).
 *      - Updates the existing ABX.TO entry: bucket → "Portfolio",
 *        weights.portfolio → 1.88 (per user direction).
 *      - Updates the existing CS.TO entry (Capstone Copper):
 *        bucket → "Portfolio", weights.portfolio → 1.82 (standard
 *        single-stock weight, per user direction).
 *   3. Updates pm:pim-models: removes CS.TO holding from groups
 *      "kpmg" and "deloitte". All other groups untouched.
 *
 * GUARDED:
 *   - Requires ?confirm=YES.
 *   - Idempotent at the shape layer: returns 200 with status
 *     "already-clean" if pm:stocks is already a proper array
 *     (no re-stash, no writes).
 *   - The stash write is the FIRST write of any kind. If anything
 *     fails after that, the pre-existing state is preserved at the
 *     returned stash key, recoverable via the undo endpoint.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const ABX_PORTFOLIO_WEIGHT = 1.88;
const CS_PORTFOLIO_WEIGHT = 1.82;

const tickerEq = (a: string | undefined, b: string): boolean => {
  if (!a) return false;
  const an = a.toUpperCase().replace("-T", ".TO");
  const bn = b.toUpperCase().replace("-T", ".TO");
  return an === bn;
};

type StockLike = {
  ticker?: string;
  name?: string;
  bucket?: "Portfolio" | "Watchlist";
  weights?: { portfolio?: number; [k: string]: unknown };
  [k: string]: unknown;
};

type Holding = { symbol: string; [k: string]: unknown };
type Group = { id: string; name: string; holdings: Holding[]; [k: string]: unknown };
type PimModelData = { groups?: Group[]; lastUpdated?: string; [k: string]: unknown };

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      { error: "Add ?confirm=YES to actually run the repair. This endpoint mutates Redis." },
      { status: 400 },
    );
  }

  try {
    const redis = await getRedis();
    const [stocksRaw, pimRaw] = await Promise.all([
      redis.get("pm:stocks"),
      redis.get("pm:pim-models"),
    ]);

    if (!stocksRaw) {
      return NextResponse.json(
        { error: "pm:stocks missing — refusing to operate on empty key" },
        { status: 500 },
      );
    }
    if (!pimRaw) {
      return NextResponse.json(
        { error: "pm:pim-models missing — refusing to operate on empty key" },
        { status: 500 },
      );
    }

    const stocksParsed = JSON.parse(stocksRaw) as unknown;
    const pimParsed = JSON.parse(pimRaw) as PimModelData;

    // ── Idempotency: refuse if pm:stocks is already a proper array ──
    if (Array.isArray(stocksParsed)) {
      return NextResponse.json({
        ok: true,
        status: "already-clean",
        stocksArrayLength: stocksParsed.length,
        note:
          "pm:stocks is already a proper array; shape repair not needed. " +
          "If symptoms persist, the cause is elsewhere (e.g. pm:pim-portfolio-state).",
      });
    }

    if (typeof stocksParsed !== "object" || stocksParsed === null) {
      return NextResponse.json(
        { error: "pm:stocks is neither an object nor an array; cannot repair" },
        { status: 500 },
      );
    }

    const sourceObj = stocksParsed as Record<string, unknown>;
    const numericKeys = Object.keys(sourceObj)
      .filter((k) => /^\d+$/.test(k))
      .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

    if (numericKeys.length === 0) {
      return NextResponse.json(
        { error: "pm:stocks has no numeric-keyed entries to recover; cannot repair safely" },
        { status: 500 },
      );
    }

    // ── Stash CURRENT state to a single key BEFORE any write ──
    const stashTs = new Date().toISOString();
    const stashKey = `pm:pre-repair-stash:${stashTs}`;
    const stashPayload = {
      stashedAt: stashTs,
      reason: "repair-multi-trade-202605-cleanup",
      "pm:stocks": stocksRaw,
      "pm:pim-models": pimRaw,
    };
    await redis.set(stashKey, JSON.stringify(stashPayload));

    // ── Rebuild pm:stocks as an array, value by value ──
    const rebuilt: StockLike[] = numericKeys
      .map((k) => sourceObj[k])
      .filter((v): v is StockLike => !!v && typeof v === "object" && "ticker" in (v as Record<string, unknown>));

    // ── Flip ABX.TO and CS.TO entries from Watchlist to Portfolio with target weights ──
    let abxFound = false;
    let abxBefore: { bucket?: string; weight?: number } = {};
    let csFound = false;
    let csBefore: { bucket?: string; weight?: number } = {};

    for (const s of rebuilt) {
      if (tickerEq(s.ticker, "ABX.TO")) {
        abxFound = true;
        abxBefore = { bucket: s.bucket, weight: s.weights?.portfolio };
        s.bucket = "Portfolio";
        s.weights = { ...(s.weights ?? {}), portfolio: ABX_PORTFOLIO_WEIGHT };
      } else if (tickerEq(s.ticker, "CS.TO")) {
        csFound = true;
        csBefore = { bucket: s.bucket, weight: s.weights?.portfolio };
        s.bucket = "Portfolio";
        s.weights = { ...(s.weights ?? {}), portfolio: CS_PORTFOLIO_WEIGHT };
      }
    }

    // Report (don't fail) if tickers are missing — surfacing this is more useful than aborting.
    const malformedStocksFieldEntries = Array.isArray((sourceObj as { stocks?: unknown[] }).stocks)
      ? ((sourceObj as { stocks: unknown[] }).stocks as unknown[]).length
      : 0;

    // ── Fix pm:pim-models: remove CS.TO from KPMG + Deloitte ──
    const csRemovals: Array<{ groupId: string; removed: number }> = [];
    const updatedGroups: Group[] = (pimParsed.groups ?? []).map((g) => {
      if (g.id !== "kpmg" && g.id !== "deloitte") return g;
      const before = g.holdings.length;
      const newHoldings = g.holdings.filter((h) => !tickerEq(h.symbol, "CS.TO"));
      const removed = before - newHoldings.length;
      if (removed > 0) {
        csRemovals.push({ groupId: g.id, removed });
        return { ...g, holdings: newHoldings };
      }
      return g;
    });

    // ── Write the two repaired blobs ──
    await redis.set("pm:stocks", JSON.stringify(rebuilt));
    await redis.set(
      "pm:pim-models",
      JSON.stringify({ ...pimParsed, groups: updatedGroups, lastUpdated: stashTs }),
    );

    return NextResponse.json({
      ok: true,
      status: "repaired",
      stashKey,
      undoUrl: `/api/admin/undo-cleanup-repair?stashKey=${encodeURIComponent(stashKey)}&confirm=YES`,
      pmStocks: {
        beforeNumericEntries: numericKeys.length,
        beforeMalformedStocksFieldEntries: malformedStocksFieldEntries,
        afterArrayLength: rebuilt.length,
        abxFound,
        abxBefore,
        abxAfter: { bucket: "Portfolio", weight: ABX_PORTFOLIO_WEIGHT },
        csFound,
        csBefore,
        csAfter: { bucket: "Portfolio", weight: CS_PORTFOLIO_WEIGHT },
      },
      pmPimModels: {
        csRemovals,
      },
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Repair failed" },
      { status: 500 },
    );
  }
}
