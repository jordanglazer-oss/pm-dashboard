import { NextResponse } from "next/server";
import { previewWatchlistAlerts, runWatchlistAlerts } from "@/app/lib/agents/watchlist-alerts";

/**
 * GET  /api/agents/watchlist-alerts — what the watchlist rules find right now
 *      (target buy price reached; newly on 2+ research lists). Read-only:
 *      raises no flag, writes nothing.
 * POST /api/agents/watchlist-alerts — run them now (raises each NEW finding
 *      as a flag, exactly as the nightly run does).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET() {
  try {
    return NextResponse.json({ mode: "PREVIEW — nothing raised", ...(await previewWatchlistAlerts()) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}

export async function POST() {
  return NextResponse.json({ mode: "RUN", ...(await runWatchlistAlerts()) });
}
