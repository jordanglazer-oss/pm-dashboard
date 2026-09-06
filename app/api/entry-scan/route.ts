import { NextRequest, NextResponse } from "next/server";
import { getEntryScan, newlyReady } from "@/app/lib/entry-scan";

/**
 * GET /api/entry-scan[?refresh=1] — the entry scorecard for every Watchlist
 * and Suggested name (app/lib/entry-conditions). Cached in pm:entry-scan for
 * 6h; `refresh=1` rebuilds. Read-only apart from that cache. Zero tokens.
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const refresh = new URL(req.url).searchParams.get("refresh") === "1";
  const scan = await getEntryScan({ refresh });
  return NextResponse.json({ ...scan, newlyReady: newlyReady(scan).map((r) => r.ticker) });
}
