import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { buildCatalystCalendar, type CatalystCalendar } from "@/app/lib/catalyst-calendar";

/**
 * GET /api/catalyst-calendar — the forward event calendar (Phase 01).
 *
 * Reads earnings dates off pm:stocks (already populated by refresh-data) and
 * econ releases from FRED, then caches the assembled calendar in
 * pm:catalyst-calendar. Pure cache — no user input, no mutation of pm:stocks.
 *
 * Query:
 *   ?refresh=1   force a rebuild (bypass the freshness check)
 *   ?window=N    look-ahead window in days (default 14, clamped 1..60)
 *
 * Freshness: rebuilt when the cache is older than 12h. On a rebuild failure
 * we fall back to the cached value (even if stale) rather than blanking —
 * same resilience contract as pm:market-regime.
 */

const log = createLogger("Catalyst");
const CACHE_KEY = "pm:catalyst-calendar";
const STALE_MS = 12 * 60 * 60 * 1000;

type StoredStock = {
  ticker?: string;
  name?: string;
  bucket?: string;
  earningsDate?: string;
};

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const forceRefresh = searchParams.get("refresh") === "1";
  const windowRaw = Number(searchParams.get("window"));
  const windowDays = Number.isFinite(windowRaw) ? Math.min(60, Math.max(1, Math.round(windowRaw))) : 14;

  const redis = await getRedis();

  // Read cache first.
  let cached: CatalystCalendar | null = null;
  try {
    const raw = await redis.get(CACHE_KEY);
    if (raw) cached = JSON.parse(raw) as CatalystCalendar;
  } catch (e) {
    log.warn("cache read failed:", e instanceof Error ? e.message : e);
  }

  const fresh =
    cached &&
    cached.windowDays === windowDays &&
    Date.now() - new Date(cached.builtAt).getTime() < STALE_MS;

  if (fresh && !forceRefresh) {
    return NextResponse.json({ calendar: cached, cached: true });
  }

  // Rebuild.
  try {
    let stocks: StoredStock[] = [];
    try {
      const raw = await redis.get("pm:stocks");
      const parsed = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) stocks = parsed as StoredStock[];
    } catch (e) {
      log.warn("pm:stocks read failed (earnings will be empty):", e instanceof Error ? e.message : e);
    }

    const calendar = await buildCatalystCalendar(stocks, windowDays);

    // Cache-only write. Never touches pm:stocks or any live data.
    try {
      await redis.set(CACHE_KEY, JSON.stringify(calendar));
    } catch (e) {
      log.warn("cache write failed (returning fresh anyway):", e instanceof Error ? e.message : e);
    }
    return NextResponse.json({ calendar, cached: false });
  } catch (e) {
    log.error("rebuild failed:", e);
    // Fall back to stale cache rather than blanking.
    if (cached) return NextResponse.json({ calendar: cached, cached: true, stale: true });
    return NextResponse.json(
      { calendar: null, error: "calendar unavailable" },
      { status: 503 },
    );
  }
}
