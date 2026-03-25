import { NextResponse } from "next/server";

// Yahoo Finance quote for VIX
async function fetchVIX(): Promise<number | null> {
  try {
    // Use Yahoo Finance v8 quote endpoint for ^VIX
    const res = await fetch(
      "https://query2.finance.yahoo.com/v8/finance/chart/%5EVIX?range=1d&interval=1d",
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
    console.error("VIX fetch error:", e);
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
    if (!res.ok) return null;
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
  // Fetch all three in parallel
  const [vix, hyOas, igOas] = await Promise.all([
    fetchVIX(),
    fetchFRED("BAMLH0A0HYM2"), // ICE BofA US High Yield OAS
    fetchFRED("BAMLC0A0CM"),   // ICE BofA US Corporate OAS (IG)
  ]);

  return NextResponse.json({
    vix,
    hyOas,
    igOas,
    fetchedAt: new Date().toISOString(),
  });
}
