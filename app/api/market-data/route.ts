import { NextResponse } from "next/server";

// Yahoo Finance quote for an index ticker
async function fetchYahooIndex(symbol: string): Promise<number | null> {
  try {
    const encoded = encodeURIComponent(symbol);
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=1d`,
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
    const price =
      meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    return price ? parseFloat(price.toFixed(2)) : null;
  } catch (e) {
    console.error(`Yahoo fetch error (${symbol}):`, e);
    return null;
  }
}

export async function GET() {
  // HY OAS and IG OAS are now manual inputs (sourced from FRED by the user)
  const [vix, move] = await Promise.all([
    fetchYahooIndex("^VIX"),
    fetchYahooIndex("^MOVE"),
  ]);

  return NextResponse.json({
    vix,
    move,
    fetchedAt: new Date().toISOString(),
  });
}
