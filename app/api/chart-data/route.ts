import { NextRequest, NextResponse } from "next/server";
import type { OHLCVBar } from "@/app/lib/technicals";
import { computeSMASeries } from "@/app/lib/technicals";

const YAHOO_BASE = "https://query2.finance.yahoo.com";

const VALID_RANGES = ["1mo", "3mo", "6mo", "1y", "2y", "5y"] as const;
type Range = (typeof VALID_RANGES)[number];

function intervalForRange(range: Range): string {
  return range === "5y" ? "1wk" : "1d";
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const ticker = searchParams.get("ticker");
    const range = (searchParams.get("range") || "1y") as Range;

    if (!ticker) {
      return NextResponse.json({ error: "ticker is required" }, { status: 400 });
    }
    if (!VALID_RANGES.includes(range)) {
      return NextResponse.json({ error: `Invalid range. Options: ${VALID_RANGES.join(", ")}` }, { status: 400 });
    }

    const interval = intervalForRange(range);
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=${range}&interval=${interval}`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });

    if (!res.ok) {
      return NextResponse.json({ error: `Yahoo Finance returned ${res.status}` }, { status: 502 });
    }

    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) {
      return NextResponse.json({ error: "No data returned" }, { status: 404 });
    }

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) {
      return NextResponse.json({ error: "No price data" }, { status: 404 });
    }

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

    const sma50 = computeSMASeries(bars, 50);
    const sma200 = computeSMASeries(bars, 200);

    return NextResponse.json({ bars, sma50, sma200, range, interval });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
