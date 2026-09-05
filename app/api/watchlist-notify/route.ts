import { NextRequest, NextResponse } from "next/server";
import { createLogger } from "@/app/lib/logger";
import { requestCoverage } from "@/app/lib/coverage-request";

/**
 * POST /api/watchlist-notify  { ticker }
 *
 * Fired (fire-and-forget) when a name is added to the Watchlist, and by the
 * Suggested Watchlist's per-row "Request coverage" button. Queues ONE email
 * to the analyst desk asking for RBC/JPM coverage on that name — the body,
 * dedupe and outbox mechanics live in app/lib/coverage-request.ts so the
 * Suggested refresh can share them.
 *
 * Sends nothing itself — it enqueues to pm:mail-outbox, which the inbox Gmail
 * Apps Script drains. So it's a no-op-until-configured feature: if the Apps
 * Script outbox poller isn't deployed, the mail simply waits in the queue.
 */

const log = createLogger("WatchlistNotify");

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { ticker?: unknown; reason?: unknown };
    const rawTicker = typeof body.ticker === "string" ? body.ticker.trim() : "";
    if (!rawTicker) return NextResponse.json({ error: "ticker required" }, { status: 400 });
    const reason = body.reason === "suggested" ? "suggested" : "watchlist";
    const r = await requestCoverage(rawTicker, reason);
    if (r.reason === "invalid") return NextResponse.json({ error: "invalid ticker" }, { status: 400 });
    return NextResponse.json(r);
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
