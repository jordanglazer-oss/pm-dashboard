import { NextRequest, NextResponse } from "next/server";

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/**
 * Fetches company name(s) from Yahoo Finance without using Claude tokens.
 * Accepts GET with ?tickers=AAPL,GOOGL,META (comma-separated, max 50).
 * Returns { names: { "AAPL": "Apple Inc.", "GOOGL": "Alphabet Inc.", ... } }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("tickers") || "";
    const tickers = raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 50);

    if (tickers.length === 0) {
      return NextResponse.json({ names: {} });
    }

    const names: Record<string, string> = {};

    // Fetch in parallel batches of 10
    const batchSize = 10;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (ticker) => {
          const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`;
          const res = await fetch(url, {
            cache: "no-store",
            headers: { "User-Agent": UA },
          });
          if (!res.ok) return { ticker, name: ticker };
          const data = await res.json();
          const price = data?.quoteSummary?.result?.[0]?.price;
          const name = price?.shortName || price?.longName || ticker;
          return { ticker, name };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          names[r.value.ticker] = r.value.name;
        }
      }
    }

    return NextResponse.json({ names });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
