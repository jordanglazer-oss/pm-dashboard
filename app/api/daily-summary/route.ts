import { NextRequest, NextResponse } from "next/server";
import { ensureDailyValuesFresh } from "@/app/lib/daily-value-refresh";
import { buildDailySummary } from "@/app/lib/daily-summary";

/**
 * GET /api/daily-summary            → the deterministic layer under the Brief
 * GET /api/daily-summary?drivers=1  → also force-rebuild pm:market-drivers
 *
 * Zero Anthropic spend. Reads caches + small read-only pulls; the only writes
 * are regenerable caches owned by the sub-builders (pm:market-drivers,
 * pm:earnings-dates, pm:change-monitor-pricebase). Never throws — sections
 * that fail come back null with an `errors` entry.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const refreshDrivers = new URL(req.url).searchParams.get("drivers") === "1";
  // The Alpha vs core cell reads pm:pim-performance, which used to be appended
  // only when the PIM Model page was open. Bring it up to date first (bounded
  // wait; a slow refresh finishes after the response) so the Brief moves
  // intraday without anyone visiting Positioning.
  let performanceRefresh: Awaited<ReturnType<typeof ensureDailyValuesFresh>> | null = null;
  try {
    performanceRefresh = await ensureDailyValuesFresh({ maxWaitMs: 12_000 });
  } catch (e) {
    console.error("[daily-summary] performance refresh failed:", e instanceof Error ? e.message : String(e));
  }
  const summary = await buildDailySummary({ refreshDrivers });
  return NextResponse.json({ ...summary, performanceRefresh });
}
