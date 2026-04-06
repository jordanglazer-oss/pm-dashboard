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

/** Resolve FUNDSERV code to Morningstar SecId via SecuritySearch */
async function lookupMorningstarSecId(code: string): Promise<string | null> {
  try {
    const url = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(code)}&limit=5`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim());
    for (const line of lines) {
      const parts = line.split("|");
      if (parts.length >= 2 && parts[1]) return parts[1]; // SecId is 2nd field
    }
    return null;
  } catch {
    return null;
  }
}

/** Fetch price from Morningstar screener API for a given SecId */
async function fetchMorningstarPrice(secId: string): Promise<number | null> {
  try {
    const url = `https://lt.morningstar.com/api/rest.svc/9vehuxllxs/security/screener?outputType=json&page=1&pageSize=1&securityDataPoints=SecId,ClosePrice&universeIds=FOCAN$$ALL&filters=SecId:IN:${encodeURIComponent(secId)}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const row = data?.rows?.[0];
    if (row && typeof row.ClosePrice === "number") {
      return parseFloat(row.ClosePrice.toFixed(2));
    }
    return null;
  } catch {
    return null;
  }
}

// Batch-fetch current prices from Yahoo Finance v8 chart API
async function fetchPrice(ticker: string): Promise<number | null> {
  // FUNDSERV codes (mutual funds) — fetch from Morningstar instead of Yahoo
  if (isFundservCode(ticker)) {
    const secId = await lookupMorningstarSecId(ticker);
    if (!secId) return null;
    return fetchMorningstarPrice(secId);
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
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    return price ? parseFloat(price.toFixed(2)) : null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest) {
  try {
    const { tickers } = await request.json();
    if (!Array.isArray(tickers) || tickers.length === 0) {
      return NextResponse.json({ error: "tickers array required" }, { status: 400 });
    }

    // Cap at 50 tickers to avoid abuse
    const batch = tickers.slice(0, 50) as string[];
    const results = await Promise.all(
      batch.map(async (t) => ({ ticker: t, price: await fetchPrice(t) }))
    );

    const prices: Record<string, number | null> = {};
    for (const r of results) {
      prices[r.ticker] = r.price;
    }

    return NextResponse.json({
      prices,
      fetchedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
