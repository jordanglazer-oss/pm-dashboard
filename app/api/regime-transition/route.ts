import { getRedis } from "@/app/lib/redis";
import { NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { computeRegimeTransition } from "@/app/lib/regime-transition";
import type { MarketRegimeData } from "@/app/lib/market-regime";

/**
 * GET /api/regime-transition — the forward regime-transition gauge (Phase 02).
 *
 * Pure derivation of the cached pm:market-regime snapshot: no new data, no new
 * Redis key, no write. Returns { transition } or { transition: null } when the
 * regime snapshot isn't cached yet (the dashboard/brief just omit the chip).
 */

const log = createLogger("RegimeTransition");

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:market-regime");
    if (!raw) return NextResponse.json({ transition: null });
    const regime = JSON.parse(raw) as MarketRegimeData;
    if (!regime?.composite) return NextResponse.json({ transition: null });
    return NextResponse.json({ transition: computeRegimeTransition(regime) });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ transition: null });
  }
}
