import { NextRequest, NextResponse } from "next/server";
import {
  factsetConfigured,
  relayHealthy,
  getFactsetPricesByTicker,
} from "@/app/lib/factset";
import { resolveFactsetId } from "@/app/lib/factset-symbols";

/**
 * READ-ONLY price diagnostic. Given ?tickers=AAPL,GOOGL,BNS.TO it reports, per
 * ticker, exactly what Yahoo and FactSet each return right now, plus relay
 * health and timing. No Redis reads/writes, no mutation — purely surfaces the
 * live upstream behavior so we can tell whether a "stale prices" incident is
 * the FactSet relay, Yahoo blocking Vercel's IPs, or something else.
 *
 * Hit it directly:
 *   https://pm-dashboard-7rr9.vercel.app/api/admin/price-debug?tickers=AAPL,GOOGL,BNS.TO
 */

const YAHOO_BASE = "https://query2.finance.yahoo.com";

function toYahoo(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  if (t.endsWith("-T")) return t.replace(/-T$/, ".TO");
  return t;
}

async function yahooPrice(ticker: string): Promise<{ price: number | null; ms: number; error?: string }> {
  const start = Date.now();
  try {
    const sym = toYahoo(ticker);
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(sym)}?range=1d&interval=1d`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 7000);
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
        cache: "no-store",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return { price: null, ms: Date.now() - start, error: `HTTP ${res.status}` };
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    return { price, ms: Date.now() - start };
  } catch (e) {
    return { price: null, ms: Date.now() - start, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

export async function GET(request: NextRequest) {
  const tickersParam = request.nextUrl.searchParams.get("tickers") || "AAPL,GOOGL,MSFT";
  const tickers = tickersParam.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 25);

  const overallStart = Date.now();

  // Relay health + FactSet batch (whole set in one call, mirrors /api/prices).
  const configured = factsetConfigured();
  const healthStart = Date.now();
  const relayOk = configured ? await relayHealthy().catch(() => false) : false;
  const relayMs = Date.now() - healthStart;

  const fsStart = Date.now();
  let factsetPrices: Record<string, number | null> = {};
  let factsetError: string | undefined;
  try {
    factsetPrices = await getFactsetPricesByTicker(tickers);
  } catch (e) {
    factsetError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  }
  const factsetMs = Date.now() - fsStart;

  // Yahoo per-ticker (concurrent).
  const yahoo = await Promise.all(tickers.map((t) => yahooPrice(t)));

  const rows = tickers.map((t, i) => {
    const resolution = resolveFactsetId(t);
    return {
      ticker: t,
      factsetResolution: resolution,
      factsetPrice: factsetPrices[t] ?? null,
      yahooPrice: yahoo[i].price,
      yahooMs: yahoo[i].ms,
      yahooError: yahoo[i].error,
    };
  });

  return NextResponse.json({
    now: new Date().toISOString(),
    env: {
      factsetConfigured: configured,
      relayHealthy: relayOk,
      relayHealthMs: relayMs,
    },
    factset: {
      batchError: factsetError,
      batchMs: factsetMs,
      resolvedCount: Object.keys(factsetPrices).length,
      requested: tickers.length,
    },
    totalMs: Date.now() - overallStart,
    rows,
  });
}
