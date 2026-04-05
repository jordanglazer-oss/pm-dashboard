import { NextRequest, NextResponse } from "next/server";

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Detect FUNDSERV codes (e.g., TDB900, RBF556, CIG686, DYN3366)
function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

// Parse the e1 field from Morningstar JSON to extract FUNDSERV codes
function parseE1Codes(e1: string): string[] {
  if (!e1) return [];
  return e1.split(",").map((entry) => entry.split("@")[0].trim().toUpperCase());
}

// Scrape fund name from Globe and Mail page title
async function lookupGlobeAndMail(code: string): Promise<string | null> {
  try {
    const url = `https://www.theglobeandmail.com/investing/markets/funds/${encodeURIComponent(code)}.CF/`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": UA, "Accept-Encoding": "identity" },
      redirect: "follow",
    });
    if (!res.ok) return null;
    const html = await res.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    if (!titleMatch) return null;
    // Title format: "Fund Name (CADFUNDS: DYN3366.CF) Quote - The Globe and Mail"
    let name = titleMatch[1]
      .replace(/\s*\(CADFUNDS:[^)]*\)\s*/i, "")
      .replace(/\s*Quote\s*-\s*The Globe and Mail\s*/i, "")
      .replace(/\s*U\$\s*/g, " USD")
      .replace(/\s*C\$\s*/g, " CAD")
      .trim();
    // Title-case the series (e.g. "Series Fh" → "Series FH")
    name = name.replace(/Series\s+(\w+)/i, (_, s) => `Series ${s.toUpperCase()}`);
    return name || null;
  } catch { return null; }
}

async function lookupFundservName(code: string): Promise<{ name: string; type: string }> {
  const codeUpper = code.toUpperCase();

  try {
    // Step 1: exact code search on Morningstar
    const url = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(code)}&limit=10`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (res.ok) {
      const text = await res.text();
      const lines = text.trim().split("\n").filter((l) => l.includes("|"));
      // Check if any result's e1 field contains this exact code
      for (const line of lines) {
        const jsonPart = line.match(/\{[^}]+\}/)?.[0];
        if (jsonPart) {
          try {
            const meta = JSON.parse(jsonPart);
            if (parseE1Codes(meta.e1 || "").includes(codeUpper)) {
              return { name: line.split("|")[0], type: "mutual-fund" };
            }
          } catch { /* continue */ }
        }
      }
      // If first result looks like a direct match (Morningstar returned a fund)
      if (lines.length > 0) {
        const firstLine = lines[0];
        const category = firstLine.split("|")[2];
        if (category === "FUND") {
          return { name: firstLine.split("|")[0], type: "mutual-fund" };
        }
      }
    }

    // Step 2: try Globe and Mail — most reliable for exact FUNDSERV code → name
    const globeName = await lookupGlobeAndMail(code);
    if (globeName) return { name: globeName, type: "mutual-fund" };

    // Step 3: prefix search on Morningstar to find the fund family
    const prefixes = [
      code.replace(/\d$/, ""),
      code.replace(/\d{2}$/, ""),
    ].filter((p, i, arr) => p !== code && p.length >= 3 && arr.indexOf(p) === i);

    for (const prefix of prefixes) {
      const prefixUrl = `https://www.morningstar.ca/ca/util/SecuritySearch.ashx?q=${encodeURIComponent(prefix)}&limit=25`;
      const prefixRes = await fetch(prefixUrl, { cache: "no-store", headers: { "User-Agent": UA } });
      if (!prefixRes.ok) continue;
      const prefixText = await prefixRes.text();
      const prefixLines = prefixText.trim().split("\n").filter((l) => l.includes("|"));
      if (prefixLines.length === 0) continue;

      // Check if any result's e1 field contains the exact code
      for (const line of prefixLines) {
        const jsonPart = line.match(/\{[^}]+\}/)?.[0];
        if (jsonPart) {
          try {
            const meta = JSON.parse(jsonPart);
            if (parseE1Codes(meta.e1 || "").includes(codeUpper)) {
              return { name: line.split("|")[0], type: "mutual-fund" };
            }
          } catch { /* continue */ }
        }
      }

      // Use the base fund family name (strip series suffix)
      const familyName = prefixLines[0].split("|")[0]
        .replace(/\s+Series\s+\w+$/i, "")
        .replace(/\s+[A-Z]{1,3}$/, "");
      if (familyName) return { name: familyName, type: "mutual-fund" };
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
