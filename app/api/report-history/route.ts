import { NextRequest, NextResponse } from "next/server";

/**
 * Batch historical adjusted-close fetcher for the Client Report. Takes
 * an array of tickers and a Yahoo range string, returns aligned daily
 * adj-close series keyed by the caller's input ticker. Designed to be
 * the single network request that drives the performance metrics block
 * (1Y / 3Y / 5Y annualized returns, volatility, upside/downside
 * capture) on the one-pager.
 *
 * Why adjusted close here (differs from live-prices.ts which uses raw):
 * The report computes long-horizon historical returns, so we want
 * dividend-and-split-adjusted values — same basis the Appendix uses.
 * Live tiles on the dashboard show today vs yesterday and need raw
 * close; that's a separate concern.
 *
 * FUNDSERV codes (Canadian mutual funds like RBF1083, DYN3366) aren't
 * in Yahoo — we return an empty series for those and the downstream
 * metrics code falls back to whatever weighting it can compute from
 * the remaining holdings. Never silently substitute data.
 */

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const YAHOO_BASE = "https://query2.finance.yahoo.com";

/** Convert local ticker format to Yahoo Finance symbol. Matches live-prices.ts / chart-data. */
function toYahoo(ticker: string): string {
  if (ticker.endsWith(".U")) return ticker.replace(/\.U$/, "-U.TO");
  if (ticker.endsWith("-T")) return ticker.replace(/-T$/, ".TO");
  return ticker;
}

function isFundservCode(ticker: string): boolean {
  return /^[A-Z]{2,4}\d{2,5}$/i.test(ticker);
}

type Row = readonly [number, number]; // [epochMs, adjClose]

async function fetchSeries(ticker: string, range: string): Promise<Row[]> {
  if (isFundservCode(ticker)) return [];
  const yahoo = toYahoo(ticker);
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(
      yahoo
    )}?range=${range}&interval=1d&events=div,split`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": UA },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];
    const ts: number[] = result.timestamp || [];
    const adj: (number | null)[] =
      result.indicators?.adjclose?.[0]?.adjclose ?? [];
    const rawClose: (number | null)[] =
      result.indicators?.quote?.[0]?.close ?? [];

    const out: Row[] = [];
    for (let i = 0; i < ts.length; i++) {
      // Prefer adjusted close; fall back to raw when the adj feed has a
      // gap. Off-market timestamps get filtered by the null check.
      const v = adj[i] ?? rawClose[i];
      if (v == null || !isFinite(v)) continue;
      out.push([ts[i] * 1000, v]);
    }
    return out;
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  let body: { tickers?: unknown; range?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const tickers = Array.isArray(body.tickers)
    ? body.tickers.filter((t): t is string => typeof t === "string")
    : [];
  // Default to 5y (covers all three reporting windows in one shot).
  const range = typeof body.range === "string" ? body.range : "5y";
  if (!tickers.length) {
    return NextResponse.json({ error: "tickers required" }, { status: 400 });
  }

  // Cap at 50 — same guard live-prices.ts uses, keeps us out of Yahoo
  // rate-limit territory.
  const batch = tickers.slice(0, 50);
  const entries = await Promise.all(
    batch.map(async (t) => [t, await fetchSeries(t, range)] as const)
  );
  const series: Record<string, Row[]> = {};
  for (const [t, s] of entries) series[t] = s;

  return NextResponse.json({ series, range, fetchedAt: new Date().toISOString() });
}
