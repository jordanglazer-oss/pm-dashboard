import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { CAD_HEDGED_SYMBOLS, baseSymbol, currencyImpact, fxRows } from "@/app/lib/currency-impact";
import { fetchUsdCad } from "@/app/lib/fx-history";
import type { PimModelData, PimPerformanceData, PimProfileType } from "@/app/lib/pim-types";

/**
 * GET /api/currency-impact[?from=YYYY-MM-DD][&to=YYYY-MM-DD][&profile=balanced]
 *
 * How much of the PIM book's C$ return came from the US dollar over a
 * period, and what the CAD-hedged holdings gave up or saved. READ-ONLY:
 * reads pm:pim-models, pm:stocks and (only when `from` is omitted, for the
 * series' start date) pm:pim-performance; fetches USD/CAD from Yahoo;
 * stores nothing.
 *
 * An ESTIMATE: the model's CURRENT target weights are applied to the whole
 * period, hedging carry is ignored, and a holding whose currency mix is not
 * on file is reported as "unclassified" rather than guessed. See
 * app/lib/currency-impact.ts.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const log = createLogger("Currency-impact");
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
const MIX_PROFILES: PimProfileType[] = ["balanced", "growth", "allEquity", "conservative"];
type StockRow = { ticker?: string; instrumentType?: "stock" | "etf" | "mutual-fund"; fundData?: { category?: string } };

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const fromQ = q.get("from");
    const toQ = q.get("to");
    if ((fromQ && !isDate(fromQ)) || (toQ && !isDate(toQ))) return NextResponse.json({ error: "from / to must be YYYY-MM-DD" }, { status: 400 });
    const today = new Date().toISOString().slice(0, 10);
    const to = toQ ?? today;

    const redis = await getRedis();
    const [modelsRaw, stocksRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks")]);
    if (!modelsRaw) return NextResponse.json({ error: "No models on file." }, { status: 404 });
    const models = JSON.parse(modelsRaw) as PimModelData;
    const pim = models.groups?.find((g) => g.id === "pim");
    if (!pim) return NextResponse.json({ error: "No PIM model on file." }, { status: 404 });

    const available = MIX_PROFILES.filter((p) => !!pim.profiles[p]);
    const wanted = q.get("profile") as PimProfileType | null;
    const profile = wanted && available.includes(wanted) ? wanted : available[0];
    if (!profile) return NextResponse.json({ error: "The PIM model has no asset-mix profile." }, { status: 404 });

    // No `from` → the start of that profile's performance series (else year to date).
    let from: string | null = fromQ ?? null;
    if (!from) {
      try {
        const perfRaw = await redis.get("pm:pim-performance");
        const perf = perfRaw ? (JSON.parse(perfRaw) as PimPerformanceData) : null;
        from = perf?.models?.find((m) => m.groupId === "pim" && m.profile === profile)?.history?.[0]?.date ?? null;
      } catch {
        from = null;
      }
      if (!from) from = `${today.slice(0, 4)}-01-01`;
    }

    const stocksParsed: unknown = stocksRaw ? JSON.parse(stocksRaw) : [];
    const stocks = (Array.isArray(stocksParsed) ? stocksParsed : []) as StockRow[];
    const info = (symbol: string) => {
      const s = stocks.find((x) => x.ticker && baseSymbol(x.ticker) === baseSymbol(symbol));
      return { known: !!s, instrumentType: s?.instrumentType, category: s?.fundData?.category };
    };

    const rows = fxRows(pim, profile, info);
    const fx = await fetchUsdCad("10y");
    const impact = currencyImpact(rows, fx, from, to);

    return NextResponse.json({
      profile,
      profiles: available,
      from,
      to,
      ...impact,
      rows,
      hedgedList: CAD_HEDGED_SYMBOLS,
      fxAvailable: fx.length > 1,
      notes: [
        "Estimate: today's model target weights are applied to the whole period.",
        "Fidelity Global Innovators is counted in full as unhedged US-dollar exposure (PM-confirmed); some of the fund is in other currencies, so the US-dollar share is slightly overstated.",
        "Hedging effect ignores the cost of hedging (carry).",
        "Separate from alpha, which is measured against the S&P 500 in C$ and is already currency-neutral.",
      ],
    });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
