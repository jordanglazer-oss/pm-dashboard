import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import type { PimModelData } from "@/app/lib/pim-types";
import { auditFund, type FundLike } from "@/app/lib/fund-data-sanity";

/**
 * GET /api/admin/fund-data-audit — READ-ONLY check of every fund and ETF on
 * file (pm:stocks, plus which are in the PIM model): sector breakdowns that
 * do not add up or describe a wrapper, asset allocation, holdings, dates,
 * fees. Reads pm:stocks and pm:pim-models; writes nothing.
 */

export const dynamic = "force-dynamic";
const log = createLogger("Fund-data-audit");

export async function GET() {
  try {
    const redis = await getRedis();
    const [stocksRaw, modelsRaw] = await Promise.all([redis.get("pm:stocks"), redis.get("pm:pim-models")]);
    const stocks = stocksRaw ? (JSON.parse(stocksRaw) as { ticker: string; name?: string; bucket?: string; instrumentType?: string; fundData?: FundLike }[]) : [];
    const models = modelsRaw ? (JSON.parse(modelsRaw) as PimModelData) : null;
    const root = (t: string) => t.toUpperCase().replace(/(-T|\.TO)$/, "");
    const inModel = new Set((models?.groups ?? []).flatMap((g) => g.holdings.map((h) => root(h.symbol))));
    const today = new Date().toISOString().slice(0, 10);

    const funds = (Array.isArray(stocks) ? stocks : []).filter((s) => s.fundData || (s.instrumentType && s.instrumentType !== "stock"));
    const rows = funds
      .map((s) => {
        const issues = auditFund(s.fundData, today);
        const top = [...(s.fundData?.sectorWeightings ?? [])].sort((a, b) => b.weight - a.weight)[0];
        return {
          ticker: s.ticker,
          name: s.name ?? "",
          inModel: inModel.has(root(s.ticker)),
          bucket: s.bucket ?? null,
          holdingsSource: s.fundData?.holdingsSource ?? null,
          holdingsDate: (s.fundData?.holdingsLastUpdated ?? s.fundData?.lastUpdated ?? "").slice(0, 10) || null,
          topSector: top ? `${top.sector} ${top.weight.toFixed(1)}%` : null,
          wrong: issues.filter((i) => i.severity === "wrong").map((i) => i.what),
          check: issues.filter((i) => i.severity === "check").map((i) => i.what),
          missing: issues.filter((i) => i.severity === "missing").map((i) => i.what),
        };
      })
      .sort((a, b) => b.wrong.length - a.wrong.length || Number(b.inModel) - Number(a.inModel) || b.check.length - a.check.length || a.ticker.localeCompare(b.ticker));

    return NextResponse.json({
      at: new Date().toISOString(),
      fundsChecked: rows.length,
      withSomethingWrong: rows.filter((r) => r.wrong.length).length,
      toCheck: rows.filter((r) => !r.wrong.length && r.check.length).length,
      clean: rows.filter((r) => !r.wrong.length && !r.check.length && !r.missing.length).length,
      note: "Read-only. 'wrong' = the stored figure cannot be right; 'check' = may be right, needs a look; 'missing' = not on file.",
      rows,
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
