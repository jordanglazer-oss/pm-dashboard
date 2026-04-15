/**
 * Shared live-price snapshot helper.
 *
 * Mirrors /api/prices/route.ts byte-for-byte so that server-side code
 * (the Appendix updater in /api/update-daily-value) can compute today's
 * return from the EXACT same inputs the UI tiles see. Before this
 * existed, the updater fetched 5d/15d ranges with adjusted close while
 * the UI fetched 1d with raw close, causing small today-only mismatches
 * between the Appendix and the Performance Tracker / Positioning tiles.
 *
 * Scope: TODAY'S SNAPSHOT ONLY. Historical day recalcs continue to use
 * adjusted close (dividend/split-adjusted) because that's the correct
 * basis for long-term performance tracking. Only the live "today"
 * number needs to match the UI.
 *
 * If /api/prices/route.ts changes, update this file in lockstep.
 */

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

// Single-ticker fetch, identical semantics to /api/prices/route.ts `fetchPrice`
async function fetchPrice(ticker: string): Promise<{ price: number | null; previousClose: number | null }> {
  if (isFundservCode(ticker)) {
    const nav = await fetchFundservPrice(ticker);
    return { price: nav, previousClose: null };
  }
  try {
    const yahooSymbol = toYahoo(ticker);
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
    if (!res.ok) return { price: null, previousClose: null };
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    const previousClose = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
    const isFx = yahooSymbol.includes("=X");
    const decimals = isFx ? 6 : 2;
    return {
      price: price ? parseFloat(price.toFixed(decimals)) : null,
      previousClose: previousClose ? parseFloat(previousClose.toFixed(decimals)) : null,
    };
  } catch {
    return { price: null, previousClose: null };
  }
}

export type LivePriceSnapshot = {
  /** Map from the caller's input ticker (unchanged) to current price */
  prices: Record<string, number | null>;
  /** Map from the caller's input ticker (unchanged) to chartPreviousClose */
  previousCloses: Record<string, number | null>;
  fetchedAt: string;
};

/**
 * Fetch a live price snapshot for the given tickers. Uses Yahoo v8/chart
 * range=1d + raw close (`meta.regularMarketPrice`, `meta.chartPreviousClose`)
 * for stocks/ETFs/FX, and Barchart NAV for FUNDSERV codes. Keyed by the
 * caller's input ticker strings.
 *
 * Keep this in lockstep with /api/prices/route.ts.
 */
export async function fetchLivePriceSnapshot(tickers: string[]): Promise<LivePriceSnapshot> {
  const batch = tickers.slice(0, 50);
  const results = await Promise.all(
    batch.map(async (t) => ({ ticker: t, ...(await fetchPrice(t)) }))
  );
  const prices: Record<string, number | null> = {};
  const previousCloses: Record<string, number | null> = {};
  for (const r of results) {
    prices[r.ticker] = r.price;
    previousCloses[r.ticker] = r.previousClose;
  }
  return { prices, previousCloses, fetchedAt: new Date().toISOString() };
}
