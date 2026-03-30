import { NextRequest, NextResponse } from "next/server";

// Batch-fetch current prices from Yahoo Finance v8 chart API
async function fetchPrice(ticker: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=1d&interval=1d`,
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
