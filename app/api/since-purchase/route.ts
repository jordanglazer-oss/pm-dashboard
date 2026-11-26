import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { fetchLivePriceSnapshot } from "@/app/lib/live-prices";
import { sameSymbol } from "@/app/lib/model-staging";
import { guessCurrency } from "@/app/lib/range-attribution-load";
import type { PimModelData } from "@/app/lib/pim-types";
import { mergeSplits } from "@/app/lib/sia-holdings";
import { siaCostBasis } from "@/app/lib/sia-cost";
import { readSiaStore, unpackTxns } from "@/app/lib/sia-store";

/**
 * GET /api/since-purchase — the price change of each position still held
 * against its average cost, from the SIA transaction log. READ-ONLY: reads
 * pm:sia-transactions and pm:pim-models, fetches latest prices, stores nothing.
 *
 * Both sides are in C$ (the log's prices are C$; a US-dollar name's latest
 * price is converted at today's USD/CAD), so a US name's figure includes the
 * currency move. PRICE ONLY: dividends and fund distributions are not in the
 * log, so they are not counted. A position with no record, an incomplete cost
 * or no price is returned with `returnPct: null` and a reason — never guessed.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const log = createLogger("Since-purchase");

export async function GET() {
  try {
    const store = await readSiaStore();
    if (!store) return NextResponse.json({ onFile: false, rows: [] });
    const modelsRaw = await (await getRedis()).get("pm:pim-models");
    const pim = modelsRaw ? (JSON.parse(modelsRaw) as PimModelData).groups?.find((g) => g.id === "pim") : null;

    const costs = siaCostBasis(unpackTxns(store.txns), mergeSplits(store.splits));
    const symbols = costs.map((c) => c.symbol);
    const prices: Record<string, number | null> = {};
    const all = [...symbols, "USDCAD=X"];
    for (let i = 0; i < all.length; i += 50) Object.assign(prices, (await fetchLivePriceSnapshot(all.slice(i, i + 50))).prices);
    const fx = prices["USDCAD=X"];

    const rows = costs.map((c) => {
      const currency = pim?.holdings.find((h) => sameSymbol(h.symbol, c.symbol))?.currency ?? guessCurrency(c.symbol);
      const p = prices[c.symbol];
      const priceCad = p != null && p > 0 ? (currency === "USD" ? (fx != null && fx > 0 ? p * fx : null) : p) : null;
      const reason = c.incomplete ? "a purchase was logged with no price" : priceCad == null ? "no latest price" : !(c.avgCost > 0) ? "no cost on file" : null;
      return {
        symbol: c.symbol,
        since: c.since,
        avgCostCad: Number.isFinite(c.avgCost) ? +c.avgCost.toFixed(4) : null,
        priceCad: priceCad == null ? null : +priceCad.toFixed(4),
        returnPct: reason || priceCad == null ? null : +((priceCad / c.avgCost - 1) * 100).toFixed(2),
        reason,
      };
    });
    return NextResponse.json({ onFile: true, through: store.last, first: store.first, at: new Date().toISOString(), rows });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
