import { NextResponse } from "next/server";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

// Yahoo Finance index symbols. ^GSPC = S&P 500, ^GSPTSE = S&P/TSX Composite.
// These are the actual indexes (not ETF proxies), so they reflect the published
// benchmark numbers commonly cited for performance reporting.
const INDEX_SYMBOLS: { key: string; yahoo: string; label: string }[] = [
  { key: "sp500", yahoo: "^GSPC", label: "S&P 500" },
  { key: "tsx", yahoo: "^GSPTSE", label: "S&P/TSX Composite" },
];

type Bar = { date: string; close: number };

async function fetchHistory(yahooSymbol: string): Promise<Bar[]> {
  try {
    // Use 10y range so 5Y returns are computable even when the target trading
    // day falls just before Yahoo's 5y cutoff (off-by-a-few-days holidays).
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
      yahooSymbol
    )}?range=10y&interval=1d`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts: number[] = result.timestamp || [];
    const closes: number[] = result.indicators?.quote?.[0]?.close || [];
    const out: Bar[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c)) continue;
      out.push({
        date: new Date(ts[i] * 1000).toISOString().split("T")[0],
        close: c,
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function GET() {
  const results = await Promise.all(
    INDEX_SYMBOLS.map(async (s) => ({
      key: s.key,
      label: s.label,
      symbol: s.yahoo,
      history: await fetchHistory(s.yahoo),
    }))
  );
  return NextResponse.json({ indexes: results });
}
