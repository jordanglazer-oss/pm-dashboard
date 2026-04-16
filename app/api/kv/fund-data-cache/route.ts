import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import type { FundHolding, FundSectorWeight } from "@/app/lib/types";

/**
 * Shared cache of fund top-holdings / sector data for tickers that
 * aren't in the user's portfolio or watchlist — populated by Refresh
 * All when it crawls the heavy (≥20%-weight) constituents of each
 * fund one level deep.
 *
 * Lets both the Top Holdings look-through panel on the stock page and
 * the Client Report X-ray expand ETF-of-ETF positions (e.g. XSP → IVV
 * → AAPL, MSFT, …) without needing every intermediate ETF to be
 * explicitly added to the portfolio.
 *
 * Kept as a single JSON blob rather than per-ticker keys because:
 *  - we always want to load the whole cache client-side anyway, so
 *    one round-trip is cheaper than N;
 *  - the expected size stays small (dozens of entries, ~10 holdings
 *    each) — Upstash handles this comfortably under the free tier.
 *
 * Shape on disk:
 *   {
 *     "IVV": {
 *       topHoldings: FundHolding[],
 *       sectorWeightings: FundSectorWeight[],
 *       holdingsSource?: string,
 *       lastUpdated: string
 *     },
 *     ...
 *   }
 */

const KEY = "pm:fund-data-cache";

export type FundDataCacheEntry = {
  topHoldings?: FundHolding[];
  sectorWeightings?: FundSectorWeight[];
  holdingsSource?: string;
  fundFamily?: string;
  lastUpdated: string;
};

export type FundDataCache = Record<string, FundDataCacheEntry>;

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ entries: {} });
    return NextResponse.json({ entries: JSON.parse(raw) as FundDataCache });
  } catch (e) {
    console.error("Redis read error (fund-data-cache):", e);
    return NextResponse.json({ entries: {} });
  }
}

/**
 * PATCH merges `entries` into the existing cache blob. We intentionally
 * merge rather than overwrite so a partial refresh (e.g. one new fund)
 * doesn't wipe the rest of the cache.
 */
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const incoming = body?.entries;
    if (!incoming || typeof incoming !== "object") {
      return NextResponse.json({ error: "entries object required" }, { status: 400 });
    }
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    const current: FundDataCache = raw ? JSON.parse(raw) : {};

    for (const [ticker, entry] of Object.entries(incoming as FundDataCache)) {
      if (!ticker || typeof ticker !== "string") continue;
      if (!entry || typeof entry !== "object") continue;
      current[ticker.toUpperCase()] = {
        ...entry,
        lastUpdated: entry.lastUpdated || new Date().toISOString(),
      };
    }

    await redis.set(KEY, JSON.stringify(current));
    return NextResponse.json({ ok: true, size: Object.keys(current).length });
  } catch (e) {
    console.error("Redis write error (fund-data-cache):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
