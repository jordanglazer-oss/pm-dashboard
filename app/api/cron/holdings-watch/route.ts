import { NextRequest, NextResponse } from "next/server";
import { runHoldingsWatch } from "@/app/lib/agents/holdings-watch";

/**
 * GET /api/cron/holdings-watch — weekday after-close holdings watch
 * (21:45 UTC = 16:45 EST / 17:45 EDT, see vercel.json). Returns fast on a
 * market holiday (no session today). Same CRON_SECRET bearer as the other
 * crons; /api/cron/* is exempt from the cookie middleware.
 *
 * Redis: writes only pm:agent-run:holdings-watch:* / holdings-day:* and,
 * when a move touches a thesis, pm:agent-flag:* — never book data.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const out = await runHoldingsWatch();
  console.log(`[cron/holdings-watch] ${out.skipped ?? out.error ?? `${out.day?.company ?? 0} company moves, ${out.day?.flagged ?? 0} flagged`}`);
  return NextResponse.json(out);
}
