import { NextResponse } from "next/server";

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

type FieldStatus = "live" | "failed" | "not-configured";

export async function GET() {
  const fredEnabled = !!process.env.FRED_API_KEY;

  // VIX/MOVE/HY OAS/IG OAS used to live here, but those values are now
  // sourced from /api/forward-looking which already exposes them with
  // history-aware deltas. This route only still serves the two fields that
  // belong to the brief's "manual sentiment" category:
  //   • VIX term structure (derived from ^VIX1M / ^VIX3M ratio)
  //   • CBOE total put/call ratio (daily CSV)
  const [vix, vix3m, putCall] = await Promise.all([
    fetchYahooIndex("^VIX"),
    fetchYahooIndex("^VIX3M"),
    fetchCboePutCall(),
  ]);

  const termStructure = deriveTermStructure(vix, vix3m);

  // Put/Call is intentionally excluded from status tracking — it's a
  // manual-entry field with Redis-backed history. The CBOE auto-fetch is
  // a best-effort convenience; when it fails we silently fall back to the
  // user's last saved value instead of showing a stale-data warning.
  const status: Record<string, FieldStatus> = {
    termStructure: termStructure != null ? "live" : "failed",
  };

  const errors: Record<string, string> = {};
  if (status.termStructure === "failed")
    errors.termStructure =
      "VIX Term Structure: Yahoo ^VIX3M or ^VIX unreachable — showing your last saved selection.";

  return NextResponse.json({
    termStructure, // "Contango" | "Flat" | "Backwardation" | null
    putCall: putCall.ratio,
    putCallAsOf: putCall.asOf,
    fredEnabled,
    status, // per-field: "live" | "failed" | "not-configured"
    errors, // per-field human-readable reason when status != "live"
    fetchedAt: new Date().toISOString(),
  });
}
