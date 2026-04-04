import { NextRequest, NextResponse } from "next/server";

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

/**
 * Fetches company name(s) and sector(s) from Yahoo Finance without using Claude tokens.
 * Uses the search/autosuggest API which does NOT require crumb/cookie auth.
 * Accepts GET with ?tickers=AAPL,GOOGL,META (comma-separated, max 50).
 * Returns { names: { "AAPL": "Apple Inc.", ... }, sectors: { "AAPL": "Technology", ... } }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("tickers") || "";
    const tickers = raw.split(",").map((t) => t.trim()).filter(Boolean).slice(0, 50);

    if (tickers.length === 0) {
      return NextResponse.json({ names: {}, sectors: {} });
    }

    const names: Record<string, string> = {};
    const sectors: Record<string, string> = {};
    const types: Record<string, string> = {};

    // Fetch in parallel batches of 10
    const batchSize = 10;
    for (let i = 0; i < tickers.length; i += batchSize) {
      const batch = tickers.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (ticker) => {
          const url = `${YAHOO_BASE}/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=0`;
          const res = await fetch(url, {
            cache: "no-store",
            headers: { "User-Agent": UA },
          });
          if (!res.ok) return { ticker, name: ticker, sector: "", type: "stock" };
          const data = await res.json();
          const quote = data?.quotes?.[0];
          if (!quote) return { ticker, name: ticker, sector: "", type: "stock" };
          // Only use result if the returned symbol matches (search can return different tickers)
          if (quote.symbol !== ticker) return { ticker, name: ticker, sector: "", type: "stock" };
          const quoteType = quote.quoteType || "EQUITY";
          const instrumentType = quoteType === "ETF" ? "etf" : quoteType === "MUTUALFUND" ? "mutual-fund" : "stock";
          return {
            ticker,
            name: quote.shortname || quote.longname || ticker,
            sector: quote.sector || "",
            type: instrumentType,
          };
        })
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          names[r.value.ticker] = r.value.name;
          if (r.value.sector) sectors[r.value.ticker] = r.value.sector;
          if (r.value.type) types[r.value.ticker] = r.value.type;
        }
      }
    }

    return NextResponse.json({ names, sectors, types });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
