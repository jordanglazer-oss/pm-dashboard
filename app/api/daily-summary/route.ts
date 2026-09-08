import { NextRequest, NextResponse } from "next/server";
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
  const summary = await buildDailySummary({ refreshDrivers });
  return NextResponse.json(summary);
}
