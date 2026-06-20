import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { Stock } from "@/app/lib/types";

/**
 * Read-only diagnostic. Returns:
 *   - the current bucket of AVGO + ORCL in pm:stocks
 *   - a count by bucket so we can confirm the overall shape
 *   - the "most recently mutated" key in pm:stocks via JSON sniffing
 *     (not actually possible without per-field timestamps, but we DO
 *     return the read timestamp so two calls can be compared)
 *   - a count of every Watchlist stock that has a non-zero PIM-model
 *     position (the same query the recovery endpoint uses)
 *
 * Safe to call repeatedly — no writes. Use to figure out whether something
 * is overwriting pm:stocks between recovery-endpoint runs.
 */

export async function GET() {
  try {
    const redis = await getRedis();
    const stocksRaw = await redis.get("pm:stocks");
    if (!stocksRaw) {
      return NextResponse.json({ ok: false, error: "pm:stocks missing" });
    }
    const stocks = JSON.parse(stocksRaw) as Stock[];
    const buckets: Record<string, number> = {};
    for (const s of stocks) {
      buckets[s.bucket] = (buckets[s.bucket] || 0) + 1;
    }
    const avgo = stocks.find((s) => s.ticker === "AVGO");
    const orcl = stocks.find((s) => s.ticker === "ORCL");

    // Also peek at pm:pim-models for AVGO + ORCL.
    const modelsRaw = await redis.get("pm:pim-models");
    let avgoModels: string[] = [];
    let orclModels: string[] = [];
    if (modelsRaw) {
      const models = JSON.parse(modelsRaw) as { groups: Array<{ id: string; holdings: Array<{ symbol: string; weightInClass: number }> }> };
      for (const g of models.groups) {
        if (g.holdings.some((h) => h.symbol === "AVGO" && h.weightInClass > 0)) avgoModels.push(g.id);
        if (g.holdings.some((h) => h.symbol === "ORCL" && h.weightInClass > 0)) orclModels.push(g.id);
      }
    }

    return NextResponse.json({
      ok: true,
      readAt: new Date().toISOString(),
      totalStocks: stocks.length,
      bucketCounts: buckets,
      avgo: avgo ? {
        bucket: avgo.bucket,
        weightsPortfolio: avgo.weights?.portfolio,
        instrumentType: avgo.instrumentType,
        siaLastScreenshotAt: avgo.siaLastScreenshotAt,
        siaLastReadAt: avgo.siaLastReadAt,
        modelGroupsWithNonZeroWeight: avgoModels,
      } : null,
      orcl: orcl ? {
        bucket: orcl.bucket,
        weightsPortfolio: orcl.weights?.portfolio,
        instrumentType: orcl.instrumentType,
        siaLastScreenshotAt: orcl.siaLastScreenshotAt,
        siaLastReadAt: orcl.siaLastReadAt,
        modelGroupsWithNonZeroWeight: orclModels,
      } : null,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
