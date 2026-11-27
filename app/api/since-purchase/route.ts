import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { fetchLivePriceSnapshot } from "@/app/lib/live-prices";
import { sameSymbol } from "@/app/lib/model-staging";
import { guessCurrency } from "@/app/lib/range-attribution-load";
import type { PimModelData } from "@/app/lib/pim-types";
import { mergeSplits } from "@/app/lib/sia-holdings";
import { lotsTotalReturn, siaCostBasis } from "@/app/lib/sia-cost";
import { fetchFundNav, isFundCode } from "@/app/lib/fund-nav";
import { SIA_BOOKS, isSiaBook, readSiaStore, unpackTxns, type SiaBook } from "@/app/lib/sia-store";

/**
 * GET /api/since-purchase[?mandate=balanced] — two figures for each position still held,
 * from the SIA transaction log: `returnPct` = OUR return, latest price against
 * our average cost (every add and trim counted); `sinceAddedPct` = the
 * security's own move since the day we first bought it (`since`, at
 * `firstPriceCad`). The two differ whenever a position was added to over time. READ-ONLY: reads
 * pm:sia-transactions (that mandate's own log when one is on file, otherwise
 * the All-Equity log — the response says which in `book`) and pm:pim-models,
 * fetches latest prices, stores nothing.
 *
 * Both sides are in C$ (the log's prices are C$; a US-dollar name's latest
 * price is converted at today's USD/CAD), so a US name's figure includes the
 * currency move. Stocks and ETFs are PRICE ONLY (dividends are not in the
 * log). MUTUAL FUNDS include reinvested distributions (`basis: "total"`): a
 * fund's NAV falls by every distribution, so price-only would understate it
 * badly; each purchase still held is grown on the distribution-adjusted NAV. A position with no record, an incomplete cost
 * or no price is returned with `returnPct: null` and a reason — never guessed.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const log = createLogger("Since-purchase");

export async function GET(req: NextRequest) {
  try {
    const wanted = new URL(req.url).searchParams.get("mandate");
    let book: SiaBook = isSiaBook(wanted) ? wanted : "allEquity";
    let store = await readSiaStore(book);
    if (!store && book !== "allEquity") {
      book = "allEquity";
      store = await readSiaStore(book);
    }
    if (!store) return NextResponse.json({ onFile: false, rows: [] });
    const modelsRaw = await (await getRedis()).get("pm:pim-models");
    const pim = modelsRaw ? (JSON.parse(modelsRaw) as PimModelData).groups?.find((g) => g.id === "pim") : null;

    const costs = siaCostBasis(unpackTxns(store.txns), mergeSplits(store.splits));
    const symbols = costs.map((c) => c.symbol);
    const prices: Record<string, number | null> = {};
    const all = [...symbols, "USDCAD=X"];
    for (let i = 0; i < all.length; i += 50) Object.assign(prices, (await fetchLivePriceSnapshot(all.slice(i, i + 50))).prices);
    const fx = prices["USDCAD=X"];

    // Mutual funds: total return of the lots still held, on the distribution-adjusted NAV.
    const fundTotal = new Map<string, number | null>();
    const fundSinceAdded = new Map<string, number | null>();
    await Promise.all(
      costs.filter((c) => isFundCode(c.symbol)).map(async (c) => {
        const days = Math.ceil((Date.now() - Date.parse(c.since)) / 86_400_000);
        const series = await fetchFundNav(c.symbol, { records: Math.min(2600, Math.ceil(days * 0.72) + 40), adjusted: true });
        if (!c.incomplete) fundTotal.set(c.symbol, lotsTotalReturn(c.lots, series));
        // The fund's own total return since the day we first bought it (one notional lot on that day).
        fundSinceAdded.set(c.symbol, lotsTotalReturn([{ date: c.since, cost: 1 }], series));
      }),
    );

    const rows = costs.map((c) => {
      const currency = pim?.holdings.find((h) => sameSymbol(h.symbol, c.symbol))?.currency ?? guessCurrency(c.symbol);
      const p = prices[c.symbol];
      const priceCad = p != null && p > 0 ? (currency === "USD" ? (fx != null && fx > 0 ? p * fx : null) : p) : null;
      const fund = isFundCode(c.symbol);
      const total = fund ? fundTotal.get(c.symbol) : undefined;
      const reason = c.incomplete ? "a purchase was logged with no price" : fund && total == null ? "no fund history back to the purchase" : priceCad == null ? "no latest price" : !(c.avgCost > 0) ? "no cost on file" : null;
      // "Since added": the security's own move since our first purchase (price only for stocks and ETFs, in C$).
      const added = fund ? (fundSinceAdded.get(c.symbol) ?? null) : priceCad != null && c.firstPrice > 0 ? (priceCad / c.firstPrice - 1) * 100 : null;
      return {
        symbol: c.symbol,
        since: c.since,
        firstPriceCad: c.firstPrice > 0 ? +c.firstPrice.toFixed(4) : null,
        sinceAddedPct: added == null ? null : +added.toFixed(2),
        avgCostCad: Number.isFinite(c.avgCost) ? +c.avgCost.toFixed(4) : null,
        priceCad: priceCad == null ? null : +priceCad.toFixed(4),
        returnPct: reason ? null : fund ? +(total as number).toFixed(2) : priceCad == null ? null : +((priceCad / c.avgCost - 1) * 100).toFixed(2),
        basis: fund ? "total" : "price",
        reason,
      };
    });
    return NextResponse.json({ onFile: true, book, bookLabel: SIA_BOOKS.find((b) => b.id === book)?.label ?? book, ownLog: book === wanted, through: store.last, first: store.first, at: new Date().toISOString(), rows });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
