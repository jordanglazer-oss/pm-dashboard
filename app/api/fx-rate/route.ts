import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/fx-rate?pair=USDCAD&date=2025-03-15
 *
 * Returns the historical (or current) FX rate for a currency pair on a
 * specific date. Uses Yahoo Finance v8 chart API with a 3-day window
 * around the target date to handle weekends/holidays (takes the closest
 * available close).
 *
 * If `date` is omitted or is today, returns the live rate.
 *
 * Response: { rate: number, date: string, symbol: string }
 */
export async function GET(request: NextRequest) {
  const pair = request.nextUrl.searchParams.get("pair"); // e.g. "USDCAD"
  const dateStr = request.nextUrl.searchParams.get("date"); // e.g. "2025-03-15"

  if (!pair || !/^[A-Z]{6}$/i.test(pair)) {
    return NextResponse.json({ error: "pair required (e.g. USDCAD)" }, { status: 400 });
  }

  const symbol = `${pair.toUpperCase()}=X`;

  // If no date or date is today, fetch live rate
  const today = new Date().toISOString().slice(0, 10);
  const isLive = !dateStr || dateStr === today;

  try {
    if (isLive) {
      const res = await fetch(
        `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
        {
          headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
          cache: "no-store",
        }
      );
      if (!res.ok) return NextResponse.json({ error: `Yahoo returned ${res.status}` }, { status: 502 });
      const data = await res.json();
      const meta = data?.chart?.result?.[0]?.meta;
      const rate = meta?.regularMarketPrice ?? meta?.previousClose;
      if (typeof rate !== "number") return NextResponse.json({ error: "No rate available" }, { status: 404 });
      return NextResponse.json({ rate: parseFloat(rate.toFixed(6)), date: today, symbol });
    }

    // Historical: use period1/period2 with a 3-day window to handle weekends
    const target = new Date(dateStr + "T12:00:00Z");
    if (isNaN(target.getTime())) {
      return NextResponse.json({ error: "Invalid date format (expected YYYY-MM-DD)" }, { status: 400 });
    }
    // Window: 3 days before to 1 day after the target
    const period1 = Math.floor((target.getTime() - 3 * 86400000) / 1000);
    const period2 = Math.floor((target.getTime() + 86400000) / 1000);

    const res = await fetch(
      `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d`,
      {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
        cache: "no-store",
      }
    );
    if (!res.ok) return NextResponse.json({ error: `Yahoo returned ${res.status}` }, { status: 502 });
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    const timestamps: number[] = result?.timestamp ?? [];
    const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close ?? [];

    if (timestamps.length === 0) {
      return NextResponse.json({ error: "No historical data for this pair/date" }, { status: 404 });
    }

    // Find the closest timestamp to the target date
    const targetTs = target.getTime() / 1000;
    let bestIdx = 0;
    let bestDist = Math.abs(timestamps[0] - targetTs);
    for (let i = 1; i < timestamps.length; i++) {
      const dist = Math.abs(timestamps[i] - targetTs);
      if (dist < bestDist && closes[i] != null) {
        bestDist = dist;
        bestIdx = i;
      }
    }

    const rate = closes[bestIdx];
    if (rate == null) return NextResponse.json({ error: "No close price on nearest date" }, { status: 404 });

    const actualDate = new Date(timestamps[bestIdx] * 1000).toISOString().slice(0, 10);
    return NextResponse.json({ rate: parseFloat(rate.toFixed(6)), date: actualDate, symbol });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
