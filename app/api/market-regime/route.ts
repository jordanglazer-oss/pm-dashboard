import { NextRequest, NextResponse } from "next/server";
import {
  REGIME_STALE_MS,
  readRegimeCache,
  refreshMarketRegime,
} from "@/app/lib/market-regime-refresh";

/**
 * Market regime endpoint.
 *
 * GET /api/market-regime            → cached value if fresh (<30min),
 *                                     else recomputes from Yahoo.
 * GET /api/market-regime?refresh=1  → forces a fresh fetch.
 *
 * The compute + cache live in app/lib/market-regime-refresh.ts so the nightly
 * cron can rebuild the snapshot too (the alert digest needs a same-day regime,
 * and this cache only ever refreshed on a page load).
 *
 * Storage: `pm:market-regime` holds the last successful `MarketRegimeData`
 * snapshot. It is a pure cache over Yahoo-derived math — it does NOT
 * contain user input. Read-error / missing-key → recompute from Yahoo
 * and write back. If the Yahoo fetch fails we fall back to whatever is
 * cached (even if stale) rather than showing an empty panel.
 *
 * CLAUDE.md compliance: no `redis.del`, no seeding with empty defaults,
 * and no overwrite from a client-supplied payload — only the server's
 * own compute is persisted here.
 */

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const forceRefresh = searchParams.get("refresh") === "1";

  const cached = await readRegimeCache();
  if (!forceRefresh && cached) {
    const age = Date.now() - new Date(cached.computedAt).getTime();
    if (isFinite(age) && age < REGIME_STALE_MS) {
      return NextResponse.json({ regime: cached, cached: true, ageMs: age });
    }
  }

  try {
    const fresh = await refreshMarketRegime();
    return NextResponse.json({ regime: fresh, cached: false, ageMs: 0 });
  } catch (e) {
    console.error("market-regime compute failed:", e);
    // Fall back to whatever is cached (even if stale). If there's no
    // cache either, return null — the UI can render a blank state.
    if (cached) {
      const age = Date.now() - new Date(cached.computedAt).getTime();
      return NextResponse.json({ regime: cached, cached: true, ageMs: age, stale: true });
    }
    return NextResponse.json({ regime: null, error: "Failed to compute and no cache available" }, { status: 503 });
  }
}
