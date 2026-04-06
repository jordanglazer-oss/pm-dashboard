import { NextRequest, NextResponse } from "next/server";
import type { OHLCVBar } from "@/app/lib/technicals";
import { computeSMASeries } from "@/app/lib/technicals";

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/** Convert local ticker format to Yahoo Finance symbol */
function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

async function fetchBars(ticker: string, range: string, interval: string): Promise<OHLCVBar[]> {
  const yahooSymbol = toYahoo(ticker);
  const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, {
    cache: "no-store",
    headers: { "User-Agent": UA },
  });
  if (!res.ok) throw new Error(`Yahoo Finance returned ${res.status}`);

  const data = await res.json();
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error("No data returned");

  const timestamps: number[] = result.timestamp || [];
  const quote = result.indicators?.quote?.[0];
  if (!quote || timestamps.length === 0) throw new Error("No price data");

  const bars: OHLCVBar[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i];
    const high = quote.high?.[i];
    const low = quote.low?.[i];
    const close = quote.close?.[i];
    const volume = quote.volume?.[i];
    if (open == null || high == null || low == null || close == null || volume == null) continue;
    bars.push({
      date: new Date(timestamps[i] * 1000).toISOString().split("T")[0],
      open, high, low, close, volume,
    });
  }
  return bars;
}

/**
 * Returns the full chart dataset for a ticker.
 * Fetches two datasets in parallel:
 *   1) Daily bars for the last 2 years (fine granularity for recent history)
 *   2) Weekly bars for max history (decades of long-term context)
 * Merges them: daily data for the recent period, weekly for anything older.
 * SMA 50 and SMA 200 are computed on the merged dataset.
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get("ticker");

    if (!ticker) {
      return NextResponse.json({ error: "ticker is required" }, { status: 400 });
    }

    // Fetch daily (2y) and weekly (max) in parallel
    const [dailyBars, weeklyBars] = await Promise.all([
      fetchBars(ticker, "2y", "1d").catch(() => [] as OHLCVBar[]),
      fetchBars(ticker, "max", "1wk").catch(() => [] as OHLCVBar[]),
    ]);

    // Merge: use weekly bars for dates before the daily range, then daily bars
    let merged: OHLCVBar[];
    if (dailyBars.length > 0 && weeklyBars.length > 0) {
      const dailyCutoff = dailyBars[0].date; // earliest daily date
      const olderWeekly = weeklyBars.filter((b) => b.date < dailyCutoff);
      merged = [...olderWeekly, ...dailyBars];
    } else if (dailyBars.length > 0) {
      merged = dailyBars;
    } else {
      merged = weeklyBars;
    }

    // Deduplicate by date (prefer later entry = higher granularity)
    const seen = new Set<string>();
    const deduped: OHLCVBar[] = [];
    for (let i = merged.length - 1; i >= 0; i--) {
      if (!seen.has(merged[i].date)) {
        seen.add(merged[i].date);
        deduped.unshift(merged[i]);
      }
    }

    const sma50 = computeSMASeries(deduped, 50);
    const sma200 = computeSMASeries(deduped, 200);

    return NextResponse.json({
      bars: deduped,
      sma50,
      sma200,
      dailyStart: dailyBars.length > 0 ? dailyBars[0].date : null,
      totalBars: deduped.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
