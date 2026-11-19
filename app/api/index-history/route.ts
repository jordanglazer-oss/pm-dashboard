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

/**
 * Extended set (`?extended=1`, Nov 2026) — the default response above is
 * unchanged. Adds the Nasdaq Composite and the S&P 500 in CANADIAN dollars
 * (^GSPC close × the USD/CAD close on or before that day) so every
 * performance panel can run a benchmark over ANY date range with the same
 * maths it uses for the models. Dates use the exchange's own clock
 * (Yahoo's gmtoffset) so the FX bars line up with the index bars.
 */
async function fetchLocalHistory(yahooSymbol: string): Promise<Bar[]> {
  try {
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}?range=10y&interval=1d`;
    const res = await fetch(url, { cache: "no-store", headers: { "User-Agent": UA } });
    if (!res.ok) return [];
    const result = (await res.json())?.chart?.result?.[0];
    if (!result) return [];
    const off: number = typeof result.meta?.gmtoffset === "number" ? result.meta.gmtoffset : 0;
    const ts: number[] = result.timestamp || [];
    const closes: (number | null)[] = result.indicators?.quote?.[0]?.close || [];
    const byDate = new Map<string, number>();
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || isNaN(c) || !(c > 0)) continue;
      byDate.set(new Date((ts[i] + off) * 1000).toISOString().slice(0, 10), c);
    }
    return [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, close]) => ({ date, close }));
  } catch {
    return [];
  }
}

/** S&P 500 in C$: each index close × the last USD/CAD close on or before it. */
function inCad(index: Bar[], fx: Bar[]): Bar[] {
  const out: Bar[] = [];
  let j = -1;
  for (const b of index) {
    while (j + 1 < fx.length && fx[j + 1].date <= b.date) j++;
    if (j >= 0) out.push({ date: b.date, close: b.close * fx[j].close });
  }
  return out;
}

export async function GET(req: Request) {
  if (new URL(req.url).searchParams.get("extended") === "1") {
    const [sp, tsx, ndq, fx] = await Promise.all(["^GSPC", "^GSPTSE", "^IXIC", "USDCAD=X"].map(fetchLocalHistory));
    return NextResponse.json({
      indexes: [
        { key: "sp500", label: "S&P 500", symbol: "^GSPC", currency: "USD", history: sp },
        { key: "sp500cad", label: "S&P 500 (C$)", symbol: "^GSPC × USDCAD", currency: "CAD", history: inCad(sp, fx) },
        { key: "nasdaq", label: "Nasdaq Composite", symbol: "^IXIC", currency: "USD", history: ndq },
        { key: "tsx", label: "S&P/TSX Composite", symbol: "^GSPTSE", currency: "CAD", history: tsx },
      ],
    });
  }
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
