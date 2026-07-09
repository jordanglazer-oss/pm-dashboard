import { NextRequest, NextResponse } from "next/server";

/** Convert local ticker format to Yahoo Finance symbol */
function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

/** Detect FUNDSERV codes (Canadian mutual funds, e.g. TDB900, RBF1083, DYN3366) */
function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

/**
 * Fetch mutual fund NAV price from Globe and Mail / Barchart EOD API.
 * Response format: "TICKER.CF,DATE,OPEN,HIGH,LOW,CLOSE,VOLUME"
 */
async function fetchFundservPrice(ticker: string): Promise<number | null> {
  try {
    const symbol = `${ticker}.CF`;
    const url = `https://globeandmail.pl.barchart.com/proxies/timeseries/queryeod.ashx?symbol=${encodeURIComponent(symbol)}&data=daily&maxrecords=1&volume=contract&order=desc&dividends=false&backadjust=false`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.theglobeandmail.com/",
      },
    });
    if (!res.ok) return null;
    const text = (await res.text()).trim();
    if (!text) return null;
    // Parse CSV: TICKER.CF,DATE,OPEN,HIGH,LOW,CLOSE,VOLUME
    const parts = text.split(",");
    if (parts.length >= 6) {
      const close = parseFloat(parts[5]);
      if (isFinite(close)) return parseFloat(close.toFixed(4));
    }
    return null;
  } catch {
    return null;
  }
}

type PriceResult = {
  price: number | null;
  previousClose: number | null;
  name: string | null;
  quoteType: string | null; // "EQUITY", "ETF", "MUTUALFUND", etc.
  currency: string | null;  // "USD", "CAD", "DKK", etc. from Yahoo meta
  dayHigh: number | null;   // today's Yahoo intraday high — freshness guard for FactSet
  dayLow: number | null;    // today's Yahoo intraday low
};

const EMPTY_RESULT: PriceResult = { price: null, previousClose: null, name: null, quoteType: null, currency: null, dayHigh: null, dayLow: null };

/** Single Yahoo v8/chart lookup for an already-resolved Yahoo symbol. */
async function fetchYahooChart(yahooSymbol: string): Promise<PriceResult> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=1d&interval=1d`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        cache: "no-store",
      }
    );
    if (!res.ok) return EMPTY_RESULT;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    const previousClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
    const name = meta?.longName ?? meta?.shortName ?? null;
    const quoteType = meta?.instrumentType ?? meta?.quoteType ?? null;
    const currency = typeof meta?.currency === "string" ? meta.currency.toUpperCase() : null;
    const dayHigh = typeof meta?.regularMarketDayHigh === "number" ? meta.regularMarketDayHigh : null;
    const dayLow = typeof meta?.regularMarketDayLow === "number" ? meta.regularMarketDayLow : null;
    // FX pairs (e.g. USDCAD=X) need full precision; stocks use 2 decimals
    const isFx = yahooSymbol.includes("=X");
    const decimals = isFx ? 6 : 2;
    return {
      price: price ? parseFloat(price.toFixed(decimals)) : null,
      previousClose: previousClose ? parseFloat(previousClose.toFixed(decimals)) : null,
      name: name ?? null,
      quoteType: quoteType ?? null,
      currency,
      dayHigh,
      dayLow,
    };
  } catch {
    return EMPTY_RESULT;
  }
}

// Batch-fetch current prices from Yahoo Finance v8 chart API
async function fetchPrice(ticker: string): Promise<PriceResult> {
  // FUNDSERV codes (mutual funds) — fetch NAV from Globe and Mail / Barchart
  if (isFundservCode(ticker)) {
    const nav = await fetchFundservPrice(ticker);
    return { price: nav, previousClose: null, name: null, quoteType: "MUTUALFUND", currency: "CAD", dayHigh: null, dayLow: null };
  }
  const yahooSymbol = toYahoo(ticker);
  const result = await fetchYahooChart(yahooSymbol);
  // TSX Venture fallback: tickers scraped from Canadian lists get a blanket
  // ".TO" suffix, but TSXV-listed names (e.g. Artemis Gold → ARTG) actually
  // live on ".V". If the ".TO" lookup found nothing, retry on ".V". Purely
  // additive — only fires when ".TO" already returned no price, so it can't
  // change any symbol that already resolves.
  if (result.price == null && yahooSymbol.endsWith(".TO")) {
    const vResult = await fetchYahooChart(yahooSymbol.replace(/\.TO$/, ".V"));
    if (vResult.price != null) return vResult;
  }
  return result;
}

export async function POST(request: NextRequest) {
  try {
    const { tickers } = await request.json();
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return NextResponse.json({ error: "tickers array required" }, { status: 400 });
    }

    // Cap to keep request bounded. The Research page batches every
    // ticker across Newton + Fundstrat + SMID + Alpha Picks into one
    // call, which can exceed 100 unique tickers. The previous cap of
    // 50 silently dropped late-arriving sources (Alpha Picks comes
    // last in the assembly), so Canadian -T entries showed blank
    // prices. 250 leaves headroom without making the upstream Yahoo
    // fan-out abusive.
    const batch = tickers.slice(0, 250) as string[];
    const results = await Promise.all(
      batch.map(async (t) => ({ ticker: t, ...(await fetchPrice(t)) }))
    );

    const prices: Record<string, number | null> = {};
    const previousCloses: Record<string, number | null> = {};
    const names: Record<string, string | null> = {};
    const quoteTypes: Record<string, string | null> = {};
    const currencies: Record<string, string | null> = {};
    for (const r of results) {
      prices[r.ticker] = r.price;
      previousCloses[r.ticker] = r.previousClose;
      names[r.ticker] = r.name;
      quoteTypes[r.ticker] = r.quoteType;
      currencies[r.ticker] = r.currency;
    }

    // Prices are Yahoo (live/intraday) for stocks + ETFs, and Globe/Barchart NAV
    // for FUNDSERV mutual funds. FactSet is deliberately NOT used for the live
    // price: the Formula API entitlement does NOT include real-time pricing
    // (P_PRICE(0) → 403 "not authorized"), and plain P_PRICE is a delayed/EOD
    // quote that intermittently lagged the tape (it once returned a prior-
    // session GOOGL price ABOVE that day's high). FactSet remains authoritative
    // for fundamentals/scoring/sector/beta — just not for prices. Reverted to
    // the pre-2026-07-02 Yahoo-primary pricing on 2026-07-09.
    const priceSources: Record<string, "yahoo"> = {};
    for (const t of batch) {
      const yp = prices[t];
      if (yp != null && yp > 0) priceSources[t] = "yahoo";
    }

    return NextResponse.json({
      prices,
      previousCloses,
      names,
      quoteTypes,
      currencies,
      priceSources,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
