/**
 * GET /api/admin/inspect-trade-state?tickers=ARX.TO,ABX.TO,NPI.TO,CS.TO
 *
 * One-off diagnostic for the post-bug repair of the multi-trade
 * Buy/Sell stale-closure issue. Returns the current state of each
 * requested ticker across pm:pim-models, pm:pim-positions, and
 * pm:stocks so the repair endpoint can apply a surgical fix.
 *
 * READ-ONLY. No Redis writes.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

type Holding = { symbol?: string; name?: string; weightInClass?: number; assetClass?: string; currency?: string };
type Group = { id: string; name: string; holdings?: Holding[] };
type PimModelData = { groups?: Group[]; lastUpdated?: string };

type Position = { symbol: string; units: number; costBasis: number };
type Portfolio = { groupId: string; profile: string; positions?: Position[]; cashBalance?: number; lastUpdated?: string };
type Positions = { portfolios?: Portfolio[] };

type Stock = { ticker: string; name?: string; bucket?: string };

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const tickersParam = searchParams.get("tickers") || "";
    const tickers = tickersParam
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter((t) => t.length > 0);
    if (tickers.length === 0) {
      return NextResponse.json({ error: "tickers query param required (comma-separated)" }, { status: 400 });
    }

    const redis = await getRedis();
    const [pimRaw, posRaw, stocksRaw] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:stocks"),
    ]);

    const pim: PimModelData = pimRaw ? JSON.parse(pimRaw) : {};
    const pos: Positions = posRaw ? JSON.parse(posRaw) : {};
    const stocks: { stocks?: Stock[] } = stocksRaw ? JSON.parse(stocksRaw) : {};

    const tickerMatch = (a: string, b: string) => {
      const an = a.toUpperCase().replace("-T", ".TO");
      const bn = b.toUpperCase().replace("-T", ".TO");
      return an === bn;
    };

    // For each requested ticker, collect appearances across the blobs.
    const report: Record<string, {
      inPimModels: Array<{ groupId: string; groupName: string; weightInClass: number; assetClass?: string; currency?: string; name?: string }>;
      inPositions: Array<{ groupId: string; profile: string; units: number; costBasis: number }>;
      inStocks: { bucket?: string; name?: string } | null;
    }> = {};

    for (const t of tickers) {
      const pimAppearances = (pim.groups ?? []).flatMap((g) => {
        const matches = (g.holdings ?? []).filter((h) => h.symbol && tickerMatch(h.symbol, t));
        return matches.map((h) => ({
          groupId: g.id,
          groupName: g.name,
          weightInClass: h.weightInClass ?? 0,
          assetClass: h.assetClass,
          currency: h.currency,
          name: h.name,
        }));
      });

      const posAppearances = (pos.portfolios ?? []).flatMap((p) => {
        const matches = (p.positions ?? []).filter((pp) => tickerMatch(pp.symbol, t));
        return matches.map((pp) => ({
          groupId: p.groupId,
          profile: p.profile,
          units: pp.units,
          costBasis: pp.costBasis,
        }));
      });

      const stockEntry = (stocks.stocks ?? []).find((s) => tickerMatch(s.ticker, t)) ?? null;

      report[t] = {
        inPimModels: pimAppearances,
        inPositions: posAppearances,
        inStocks: stockEntry ? { bucket: stockEntry.bucket, name: stockEntry.name } : null,
      };
    }

    return NextResponse.json({
      generatedAt: new Date().toISOString(),
      tickers,
      report,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Failed to inspect trade state" },
      { status: 500 },
    );
  }
}
