import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { SALES_LEDGER_KEY, type SaleEvent } from "@/app/lib/sales-ledger";
import { baseSymbol } from "@/app/lib/currency-impact";
import { fetchUsdCad } from "@/app/lib/fx-history";
import { history } from "@/app/lib/holding-history";
import { LEDGER_STARTED, tallyRealized } from "@/app/lib/realized-gains";
import type { PimModelData, PimPortfolioState, PimTransaction } from "@/app/lib/pim-types";

/**
 * GET /api/realized-gains[?year=YYYY] — realized gains / losses per book for
 * the year, as % OF THE BOOK (never dollars; a model-level estimate).
 * READ-ONLY: reads pm:pim-sales-ledger, pm:pim-portfolio-state and
 * pm:pim-models, plus Yahoo / Barchart prices to value each book on the day
 * of a sale; stores nothing. Only covers sales from 2026-11-19 on, when the
 * ledger began. Rules in app/lib/realized-gains.ts.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const log = createLogger("Realized-gains");

/** Currency from the listing when the symbol is no longer in any model. */
function currencyFromSymbol(symbol: string): "CAD" | "USD" | null {
  const s = symbol.trim().toUpperCase();
  if (/\.U(-T|\.TO)?$|-U\.TO$/.test(s)) return "USD"; // US$ units listed in Toronto
  if (/(-T|\.TO|\.NE|-NE)$/.test(s) || /^[A-Z]{2,4}\d{2,5}$/.test(s)) return "CAD"; // Toronto listing or a FUNDSERV code
  return null;
}

export async function GET(req: NextRequest) {
  const year = new URL(req.url).searchParams.get("year") ?? new Date().toISOString().slice(0, 4);
  if (!/^\d{4}$/.test(year)) return NextResponse.json({ error: "year must be YYYY" }, { status: 400 });
  const empty = { year, coversFrom: LEDGER_STARTED, sales: [], uncounted: [], books: [] };
  try {
    const redis = await getRedis();
    const [ledgerRaw, stateRaw, modelsRaw] = await Promise.all([redis.get(SALES_LEDGER_KEY), redis.get("pm:pim-portfolio-state"), redis.get("pm:pim-models")]);
    const ledger: unknown = ledgerRaw ? JSON.parse(ledgerRaw) : null;
    const all = (ledger && typeof ledger === "object" && Array.isArray((ledger as { events?: unknown }).events) ? (ledger as { events: SaleEvent[] }).events : []) as SaleEvent[];
    const events = all.filter((e) => e && typeof e.date === "string" && e.date.startsWith(year));
    if (!events.length) return NextResponse.json({ ...empty, eventsOnFile: all.length });

    const state = stateRaw ? (JSON.parse(stateRaw) as PimPortfolioState) : null;
    const txns: PimTransaction[] = (state?.groupStates ?? []).flatMap((g) => (g.transactions ?? []).map((t) => ({ ...t, groupId: t.groupId || g.groupId })));
    const models = modelsRaw ? (JSON.parse(modelsRaw) as PimModelData) : null;
    const modelCcy = new Map<string, "CAD" | "USD">();
    for (const g of models?.groups ?? []) for (const h of g.holdings ?? []) if (!modelCcy.has(baseSymbol(h.symbol))) modelCcy.set(baseSymbol(h.symbol), h.currency);
    const currencyOf = (symbol: string) => modelCcy.get(baseSymbol(symbol)) ?? currencyFromSymbol(symbol);

    // Prices to value each book on its sale day: every symbol in any bookBefore.
    const symbols = [...new Set(events.flatMap((e) => (e.bookBefore ?? []).map((p) => p.symbol)))];
    const since = events.map((e) => e.date).sort()[0];
    const [fx, ...series] = await Promise.all([fetchUsdCad("2y"), ...symbols.map((s) => history(s, since))]);
    const bySymbol = new Map(symbols.map((s, i) => [s, series[i]]));
    const onOrBefore = (dates: string[], vals: number[], date: string): number | null => {
      let v: number | null = null;
      for (let i = 0; i < dates.length && dates[i] <= date; i++) v = vals[i];
      return v;
    };
    const fxOn = (date: string) => onOrBefore(fx.map((p) => p.date), fx.map((p) => p.value), date);
    const priceCadOn = (symbol: string, date: string): number | null => {
      const s = bySymbol.get(symbol);
      const p = s ? onOrBefore(s.dates, s.adj, date) : null;
      if (p == null) return null;
      const ccy = currencyOf(symbol);
      if (ccy === "CAD") return p;
      if (ccy !== "USD") return null;
      const f = fxOn(date);
      return f == null ? null : p * f;
    };

    return NextResponse.json({ ...tallyRealized(events, txns, { currencyOf, fxOn, priceCadOn }, year), eventsOnFile: all.length });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ...empty, error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
