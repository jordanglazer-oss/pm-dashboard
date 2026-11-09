import { NextRequest, NextResponse } from "next/server";
import { runStanceWatch } from "@/app/lib/agents/stance-watch";

/**
 * GET /api/cron/stance-watch — weekday after-close stance watch + hedge
 * window (22:00 UTC = 17:00 EST / 18:00 EDT, see vercel.json). CRON_SECRET
 * bearer; /api/cron/* is exempt from the cookie middleware.
 * Redis: writes only pm:agent-state:stance and, on a change, pm:agent-flag:*.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const out = await runStanceWatch();
    console.log(`[cron/stance-watch] ${out.skipped ?? out.error ?? `${out.state?.changes?.length ?? 0} changes, hedge window ${out.state?.hedgeWindow.window}`}`);
    return NextResponse.json(out);
  } catch (e) {
    console.error("[cron/stance-watch] failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
