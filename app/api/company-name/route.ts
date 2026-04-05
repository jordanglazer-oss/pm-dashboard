import { NextRequest, NextResponse } from "next/server";

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Detect FUNDSERV codes (e.g., TDB900, RBF556, CIG686, DYN3366)
function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

async function lookupFundservName(code: string): Promise<{ name: string; type: string }> {
  try {
    // First try exact code match
    const url = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(code)}&limit=5`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split("\n");
      if (lines.length > 0 && lines[0].includes("|")) {
        const name = lines[0].split("|")[0];
        if (name) return { name, type: "mutual-fund" };
      }
    }

    // If exact lookup failed, try prefix searches (strip 1 digit, then 2)
    // to find the fund family. E.g. DYN3366 → try DYN336 first, then DYN33
    const prefixes = [
      code.replace(/\d$/, ""),       // strip 1 digit: DYN3366 → DYN336
      code.replace(/\d{2}$/, ""),    // strip 2 digits: DYN3366 → DYN33
    ].filter((p, i, arr) => p !== code && p.length >= 3 && arr.indexOf(p) === i);

    for (const prefix of prefixes) {
      const prefixUrl = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(prefix)}&limit=25`;
      const prefixRes = await fetch(prefixUrl, { cache: "no-store", headers: { "User-Agent": UA } });
      if (!prefixRes.ok) continue;
      const prefixText = await prefixRes.text();
      const prefixLines = prefixText.trim().split("\n").filter((l) => l.includes("|"));
      if (prefixLines.length === 0) continue;

      // First check if any result's e1 field contains this exact code
      for (const line of prefixLines) {
        if (line.includes(code)) {
          const name = line.split("|")[0];
          if (name) return { name, type: "mutual-fund" };
        }
      }
      // Otherwise use the first result's name (same fund family)
      const name = prefixLines[0].split("|")[0];
      if (name) return { name, type: "mutual-fund" };
    }
  } catch { /* fallback */ }
  return { name: code, type: "mutual-fund" };
}

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
          // FUNDSERV codes (Canadian mutual funds) — use Morningstar lookup
          if (isFundservCode(ticker)) {
            const { name, type } = await lookupFundservName(ticker);
            return { ticker, name, sector: "", type };
          }

          // Regular tickers — use Yahoo Finance search
          // For Canadian USD ETFs (e.g. XUS.U), Yahoo uses XUS-U.TO format
          const yahooQuery = ticker.endsWith(".U")
            ? ticker.replace(".U", "-U.TO")
            : ticker;
          const url = `${YAHOO_BASE}/v1/finance/search?q=${encodeURIComponent(yahooQuery)}&quotesCount=1&newsCount=0`;
          const res = await fetch(url, {
            cache: "no-store",
            headers: { "User-Agent": UA },
          });
          if (!res.ok) return { ticker, name: ticker, sector: "", type: "stock" };
          const data = await res.json();
          const quote = data?.quotes?.[0];
          if (!quote) return { ticker, name: ticker, sector: "", type: "stock" };
          // Accept result if returned symbol matches the ticker or the Yahoo variant
          const symbolMatch = quote.symbol === ticker
            || quote.symbol === yahooQuery
            || quote.symbol === ticker.replace(".U", "-U.TO");
          if (!symbolMatch) return { ticker, name: ticker, sector: "", type: "stock" };
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
