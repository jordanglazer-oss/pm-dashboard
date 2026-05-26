/**
 * POST /api/admin/fix-finn-currency?confirm=YES
 *
 * One-shot data fix: corrects the currency field on the Fidelity Global
 * Innovators ETF (FINN.NE / FINN-T) wherever it's wrongly stored as USD
 * or missing. FINN.NE trades on the NEO Exchange in Canadian dollars
 * (the fund migrated from TSX:FINN-T at some point); the legacy
 * pm:pim-models entry for non-res had currency:"USD", which threw off
 * the CAD/USD Model column calculations in PimModel and the currency
 * badge in PimPortfolio.
 *
 * What this endpoint does:
 *   1. Stashes pm:pim-models and pm:stocks to pm:pre-finn-fix-stash:{ts}
 *      as the first write (rollback via /api/admin/undo-finn-fix or by
 *      replaying the stashed blobs).
 *   2. In pm:pim-models: walks every group's holdings; for each holding
 *      with symbol matching FINN.NE or FINN-T whose currency != "CAD",
 *      sets currency to "CAD".
 *   3. In pm:stocks: finds entries with ticker matching FINN.NE or FINN-T
 *      and sets currency to "CAD" if missing or not already CAD.
 *
 * No other fields are touched. Read-modify-write with spread preservation.
 * Idempotent: returns "no-op" if every FINN entry already has currency
 * "CAD".
 *
 * GUARDED: requires ?confirm=YES.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const FINN_SYMBOLS = new Set(["FINN.NE", "FINN-T", "FINN.TO"]);

type Holding = {
  symbol: string;
  name?: string;
  currency?: string;
  assetClass?: string;
  weightInClass?: number;
  [k: string]: unknown;
};

type Group = {
  id: string;
  name: string;
  holdings: Holding[];
  [k: string]: unknown;
};

type PimModelData = {
  groups?: Group[];
  lastUpdated?: string;
  [k: string]: unknown;
};

type StockLike = {
  ticker?: string;
  currency?: string;
  [k: string]: unknown;
};

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      { error: "Add ?confirm=YES to actually run the fix. This endpoint mutates Redis." },
      { status: 400 },
    );
  }

  try {
    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:stocks"),
    ]);

    if (!pimRaw) {
      return NextResponse.json(
        { error: "pm:pim-models missing — refusing to operate" },
        { status: 500 },
      );
    }
    if (!stocksRaw) {
      return NextResponse.json(
        { error: "pm:stocks missing — refusing to operate" },
        { status: 500 },
      );
    }

    const pimParsed = JSON.parse(pimRaw) as PimModelData;
    const stocksParsed = JSON.parse(stocksRaw) as unknown;
    if (!Array.isArray(stocksParsed)) {
      return NextResponse.json(
        { error: "pm:stocks is not an array — run cleanup endpoint first" },
        { status: 500 },
      );
    }
    const stocks = stocksParsed as StockLike[];

    // ── Stash current state BEFORE any write ──
    const stashTs = new Date().toISOString();
    const stashKey = `pm:pre-finn-fix-stash:${stashTs}`;
    await redis.set(
      stashKey,
      JSON.stringify({
        stashedAt: stashTs,
        reason: "fix-finn-currency",
        "pm:pim-models": pimRaw,
        "pm:stocks": stocksRaw,
      }),
    );

    // ── Walk pm:pim-models, fix any FINN holding ──
    const modelChanges: Array<{ groupId: string; symbol: string; oldCurrency: string | undefined; newCurrency: string }> = [];
    const groups: Group[] = Array.isArray(pimParsed.groups) ? pimParsed.groups : [];
    const updatedGroups: Group[] = groups.map((g) => {
      const newHoldings = g.holdings.map((h) => {
        if (!FINN_SYMBOLS.has(h.symbol)) return h;
        if (h.currency === "CAD") return h;
        modelChanges.push({
          groupId: g.id,
          symbol: h.symbol,
          oldCurrency: h.currency,
          newCurrency: "CAD",
        });
        return { ...h, currency: "CAD" };
      });
      return { ...g, holdings: newHoldings };
    });

    // ── Walk pm:stocks, fix any FINN entry ──
    const stocksChanges: Array<{ ticker: string; oldCurrency: string | undefined; newCurrency: string }> = [];
    const updatedStocks = stocks.map((s) => {
      if (!s.ticker || !FINN_SYMBOLS.has(s.ticker)) return s;
      if (s.currency === "CAD") return s;
      stocksChanges.push({
        ticker: s.ticker,
        oldCurrency: s.currency,
        newCurrency: "CAD",
      });
      return { ...s, currency: "CAD" };
    });

    // ── Idempotency check ──
    if (modelChanges.length === 0 && stocksChanges.length === 0) {
      return NextResponse.json({
        ok: true,
        status: "no-op",
        note: "All FINN entries already have currency 'CAD'. No write performed.",
        stashKey,
      });
    }

    // ── Write back ──
    if (modelChanges.length > 0) {
      await redis.set(
        "pm:pim-models",
        JSON.stringify({ ...pimParsed, groups: updatedGroups, lastUpdated: stashTs }),
      );
    }
    if (stocksChanges.length > 0) {
      await redis.set("pm:stocks", JSON.stringify(updatedStocks));
    }

    return NextResponse.json({
      ok: true,
      status: "fixed",
      stashKey,
      modelChanges,
      stocksChanges,
      note: "pm:pim-models and/or pm:stocks updated. To roll back, replay the stash key contents (each blob is stored verbatim under 'pm:pim-models' and 'pm:stocks' fields in the stash payload).",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Fix failed" },
      { status: 500 },
    );
  }
}
