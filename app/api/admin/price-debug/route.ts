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

type YahooOut = { price: number | null; dayHigh: number | null; dayLow: number | null; ms: number; error?: string };

async function yahooPrice(ticker: string): Promise<YahooOut> {
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
    if (!res.ok) return { price: null, dayHigh: null, dayLow: null, ms: Date.now() - start, error: `HTTP ${res.status}` };
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    const price = typeof meta?.regularMarketPrice === "number" ? meta.regularMarketPrice : null;
    const dayHigh = typeof meta?.regularMarketDayHigh === "number" ? meta.regularMarketDayHigh : null;
    const dayLow = typeof meta?.regularMarketDayLow === "number" ? meta.regularMarketDayLow : null;
    return { price, dayHigh, dayLow, ms: Date.now() - start };
  } catch (e) {
    return { price: null, dayHigh: null, dayLow: null, ms: Date.now() - start, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
  }
}

export async function GET(request: NextRequest) {
  const tickersParam = request.nextUrl.searchParams.get("tickers") || "AAPL,GOOGL,MSFT";
  const tickers = tickersParam.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 25);

  const overallStart = Date.now();

  // Relay health + FactSet batch (whole set in one call, mirrors /api/prices).
  const configured = factsetConfigured();
  const healthStart = Date.now();
  // Bound the health check — relayHealthy()'s own fetch has no timeout, so if
  // the relay host is unreachable it could stall the whole diagnostic. Race it
  // against a short timer so the endpoint always returns.
  const relayOk = configured
    ? await Promise.race([
        relayHealthy().catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ])
    : false;
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
    const fp = factsetPrices[t] ?? null;
    const hi = yahoo[i].dayHigh;
    const lo = yahoo[i].dayLow;
    // Mirror /api/prices' freshness guard so the diagnostic shows which source
    // would actually be used: FactSet is "fresh" when inside today's range.
    let factsetFresh: boolean | null = null;
    if (typeof fp === "number" && hi != null && lo != null && lo > 0) {
      factsetFresh = fp >= lo * 0.995 && fp <= hi * 1.005;
    }
    return {
      ticker: t,
      factsetResolution: resolution,
      factsetPrice: fp,
      yahooPrice: yahoo[i].price,
      yahooDayHigh: hi,
      yahooDayLow: lo,
      factsetFresh, // true = FactSet current (would be used) · false = stale (Yahoo used) · null = no range
      sourceUsed: factsetFresh === false ? "yahoo" : typeof fp === "number" ? "factset" : "yahoo",
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
