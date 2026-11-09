import { NextRequest, NextResponse } from "next/server";
import { writeSundayMemo } from "@/app/lib/agents/sunday-memo";

/**
 * GET /api/cron/sunday-memo — Sunday 22:00 UTC (17:00 EST / 18:00 EDT, see
 * vercel.json): writes the week's memo and queues it to ALERT_EMAIL_TO via
 * the Gmail outbox. CRON_SECRET bearer. Writes only pm:agent-memo:<date>
 * and pm:mail-outbox.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const out = await writeSundayMemo({ email: true });
  console.log(`[cron/sunday-memo] ${out.ok ? `${out.memo?.items.length} items${out.memo?.emailed ? ", emailed" : ""}` : out.error}`);
  return NextResponse.json(out);
}
