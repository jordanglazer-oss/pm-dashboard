import { NextRequest, NextResponse } from "next/server";
import type { OHLCVBar } from "@/app/lib/technicals";
import { computeTechnicals, computeImprovingSignals } from "@/app/lib/technicals";
import type { ImprovingScore, TechnicalIndicators } from "@/app/lib/technicals";
import { UNIVERSES } from "@/app/lib/universes";
import type { UniverseKey } from "@/app/lib/universes";

const YAHOO_BASE = "https://query2.finance.yahoo.com";
const BATCH_SIZE = 8; // parallel fetches per batch
const BATCH_DELAY_MS = 300; // delay between batches to avoid throttling

async function fetchPriceHistory(ticker: string): Promise<OHLCVBar[]> {
  try {
    const url = `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(ticker)}?range=1y&interval=1d`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    if (!res.ok) return [];
    const data = await res.json();
    const result = data?.chart?.result?.[0];
    if (!result) return [];

    const timestamps: number[] = result.timestamp || [];
    const quote = result.indicators?.quote?.[0];
    if (!quote || timestamps.length === 0) return [];

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
  } catch {
    return [];
  }
}

export type ScanResult = {
  ticker: string;
  name: string;
  price: number;
  priceChange5d: number;
  priceChange20d: number;
  technicals: TechnicalIndicators;
  improving: ImprovingScore;
};

async function fetchCompanyName(ticker: string): Promise<string> {
  try {
    const url = `${YAHOO_BASE}/v10/finance/quoteSummary/${encodeURIComponent(ticker)}?modules=price`;
    const res = await fetch(url, {
      cache: "no-store",
      headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
    });
    if (!res.ok) return ticker;
    const data = await res.json();
    const price = data?.quoteSummary?.result?.[0]?.price;
    return price?.shortName || price?.longName || ticker;
  } catch {
    return ticker;
  }
}

async function scanTicker(ticker: string): Promise<ScanResult | null> {
  try {
    const [bars, name] = await Promise.all([
      fetchPriceHistory(ticker),
      fetchCompanyName(ticker),
    ]);
    if (bars.length < 30) return null;

    const technicals = computeTechnicals(bars);
    if (!technicals) return null;

    const improving = computeImprovingSignals(bars, technicals);

    return {
      ticker,
      name,
      price: technicals.currentPrice,
      priceChange5d: technicals.priceChange5d,
      priceChange20d: technicals.priceChange20d,
      technicals,
      improving,
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const universe = body.universe as UniverseKey;
    const minScore = (body.minScore as number) ?? 2; // minimum improving score to include
    const existingTickers = (body.existingTickers as string[]) ?? []; // already in portfolio/watchlist

    if (!universe || !UNIVERSES[universe]) {
      return NextResponse.json(
        { error: `Invalid universe. Options: ${Object.keys(UNIVERSES).join(", ")}` },
        { status: 400 }
      );
    }

    const tickers = UNIVERSES[universe];
    const existingSet = new Set(existingTickers.map((t) => t.toUpperCase()));

    // Filter out tickers already in portfolio/watchlist
    const toScan = tickers.filter((t) => !existingSet.has(t.replace(".TO", "").toUpperCase()));

    // Process in batches
    const results: ScanResult[] = [];
    let processed = 0;

    for (let i = 0; i < toScan.length; i += BATCH_SIZE) {
      const batch = toScan.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(batch.map(scanTicker));

      for (const r of batchResults) {
        if (r && r.improving.score >= minScore) {
          results.push(r);
        }
      }

      processed += batch.length;

      // Small delay between batches to avoid Yahoo throttling
      if (i + BATCH_SIZE < toScan.length) {
        await delay(BATCH_DELAY_MS);
      }
    }

    // Sort by improving score descending, then by 20d momentum
    results.sort((a, b) => {
      if (b.improving.score !== a.improving.score) return b.improving.score - a.improving.score;
      return b.priceChange20d - a.priceChange20d;
    });

    return NextResponse.json({
      universe,
      total: toScan.length,
      processed,
      found: results.length,
      results,
      scannedAt: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Scan universe error:", message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
