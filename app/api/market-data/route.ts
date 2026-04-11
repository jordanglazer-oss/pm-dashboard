import { NextResponse } from "next/server";
import { fredSeries } from "@/app/lib/forward-looking";

const YH_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Yahoo Finance quote for an index ticker
async function fetchYahooIndex(symbol: string): Promise<number | null> {
  try {
    const encoded = encodeURIComponent(symbol);
    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?range=1d&interval=1d`,
      {
        headers: { "User-Agent": YH_UA },
        cache: "no-store",
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const meta = data?.chart?.result?.[0]?.meta;
    const price = meta?.regularMarketPrice ?? meta?.previousClose ?? null;
    return price ? parseFloat(price.toFixed(2)) : null;
  } catch (e) {
    console.error(`Yahoo fetch error (${symbol}):`, e);
    return null;
  }
}

// Derive VIX term structure label from the VIX1M (spot) / VIX3M ratio.
// Convention: VIX3M > VIX1M → Contango (normal), VIX3M < VIX1M → Backwardation
// (stress). We use a ±5% dead-band around 1.0 so tiny wiggles register as Flat.
function deriveTermStructure(
  vix: number | null,
  vix3m: number | null
): "Contango" | "Flat" | "Backwardation" | null {
  if (vix == null || vix3m == null || vix <= 0) return null;
  const ratio = vix3m / vix;
  if (ratio >= 1.05) return "Contango";
  if (ratio <= 0.95) return "Backwardation";
  return "Flat";
}

// Fetch the CBOE total Put/Call ratio from the public daily CSV. CBOE does not
// publish an official API; the CSV at cdn.cboe.com is the cleanest free source.
// Defensive parsing: if the column layout changes we fall back to null instead
// of breaking the brief.
async function fetchCboePutCall(): Promise<{
  ratio: number | null;
  asOf: string | null;
}> {
  const urls = [
    "https://cdn.cboe.com/api/global/us_indices/daily_prices/TOTAL_PC.csv",
    "https://www.cboe.com/us/options/market_statistics/daily/download/?dt=",
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": YH_UA, Accept: "text/csv,text/plain,*/*" },
        cache: "no-store",
      });
      if (!res.ok) continue;
      const text = await res.text();
      const lines = text
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0);
      if (lines.length < 2) continue;

      // Locate the header row — CBOE sometimes prefixes the CSV with a few
      // metadata lines. Accept any row that contains "DATE" and "RATIO".
      let headerIdx = 0;
      for (let i = 0; i < Math.min(lines.length, 6); i++) {
        const upper = lines[i].toUpperCase();
        if (upper.includes("DATE") && upper.includes("RATIO")) {
          headerIdx = i;
          break;
        }
      }
      const header = lines[headerIdx].split(",").map((h) => h.trim().toUpperCase());
      const ratioCol = header.findIndex((h) => h.includes("RATIO"));
      const dateCol = header.findIndex((h) => h === "DATE" || h.startsWith("DATE"));
      if (ratioCol === -1) continue;

      // Last data row = most recent observation (CBOE publishes oldest→newest).
      const lastRow = lines[lines.length - 1].split(",");
      const rawRatio = lastRow[ratioCol]?.replace(/"/g, "").trim();
      const rawDate = dateCol >= 0 ? lastRow[dateCol]?.replace(/"/g, "").trim() : null;
      const parsed = parseFloat(rawRatio);
      if (!isNaN(parsed) && parsed > 0 && parsed < 5) {
        return { ratio: parseFloat(parsed.toFixed(2)), asOf: rawDate ?? null };
      }
    } catch (e) {
      console.error(`CBOE P/C fetch error (${url}):`, e);
    }
  }
  return { ratio: null, asOf: null };
}

export async function GET() {
  // Fetch all live data points in parallel. Every source can fail
  // independently — the UI will keep the prior persisted value for any field
  // that comes back null, and the user can still edit it manually.
  const [vix, move, vix3m, putCall, hyObs, igObs] = await Promise.all([
    fetchYahooIndex("^VIX"),
    fetchYahooIndex("^MOVE"),
    fetchYahooIndex("^VIX3M"),
    fetchCboePutCall(),
    fredSeries("BAMLH0A0HYM2", 1),
    fredSeries("BAMLC0A0CM", 1),
  ]);

  const termStructure = deriveTermStructure(vix, vix3m);

  // FRED BAML OAS series are published in percent — convert to bps for parity
  // with how the rest of the app stores credit spreads.
  const hyOas =
    hyObs && hyObs[0] && !isNaN(hyObs[0].value)
      ? Math.round(hyObs[0].value * 100)
      : null;
  const igOas =
    igObs && igObs[0] && !isNaN(igObs[0].value)
      ? Math.round(igObs[0].value * 100)
      : null;

  return NextResponse.json({
    vix,
    move,
    vix3m,
    termStructure, // "Contango" | "Flat" | "Backwardation" | null
    putCall: putCall.ratio,
    putCallAsOf: putCall.asOf,
    hyOas, // bps, null if FRED key not set or fetch failed
    igOas, // bps, null if FRED key not set or fetch failed
    fredEnabled: !!process.env.FRED_API_KEY,
    fetchedAt: new Date().toISOString(),
  });
}
