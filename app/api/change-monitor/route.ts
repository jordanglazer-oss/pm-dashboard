import { NextRequest, NextResponse } from "next/server";
import { loadChangeEvents } from "@/app/lib/change-monitor-load";

/**
 * GET /api/change-monitor?window=7
 *
 * Returns the typed "what changed" event list for the Dashboard change
 * monitor. Read-mostly: the only write is maintaining a small rolling price
 * baseline (pm:change-monitor-pricebase, a pure cache) so price moves can be
 * measured "since ~last week" without an external history fetch. Input
 * assembly lives in app/lib/change-monitor-load.ts (shared with the daily
 * summary).
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const windowDays = Math.max(1, Math.min(90, parseInt(new URL(req.url).searchParams.get("window") || "7", 10) || 7));
  const nowMs = Date.now();
  try {
    const events = await loadChangeEvents(windowDays, nowMs);
    return NextResponse.json({ generatedAt: new Date(nowMs).toISOString(), windowDays, count: events.length, events });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed", events: [] }, { status: 200 });
  }
}
