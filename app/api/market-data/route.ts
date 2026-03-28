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

// FRED API for credit spreads
async function fetchFRED(seriesId: string): Promise<number | null> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.error("FRED_API_KEY not set");
    return null;
  }
  try {
    const res = await fetch(
      `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&sort_order=desc&limit=1&file_type=json&api_key=${apiKey}`,
      { cache: "no-store" }
    );
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`FRED API error (${seriesId}): ${res.status} ${errText}`);
      return null;
    }
    const data = await res.json();
    const value = data?.observations?.[0]?.value;
    if (!value || value === ".") return null;
    return parseFloat(parseFloat(value).toFixed(0));
  } catch (e) {
    console.error(`FRED fetch error (${seriesId}):`, e);
    return null;
  }
}

export async function GET() {
  // Fetch all four in parallel
  const [vix, move, hyOas, igOas] = await Promise.all([
    fetchYahooIndex("^VIX"),
    fetchYahooIndex("^MOVE"),
    fetchFRED("BAMLH0A0HYM2"), // ICE BofA US High Yield OAS
    fetchFRED("BAMLC0A0CM"),   // ICE BofA US Corporate OAS (IG)
  ]);

  return NextResponse.json({
    vix,
    move,
    hyOas,
    igOas,
    fetchedAt: new Date().toISOString(),
  });
}
