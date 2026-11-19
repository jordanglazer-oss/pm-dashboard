import { NextRequest, NextResponse } from "next/server";
import { runHealthReport } from "@/app/lib/health-report";
import { createLogger } from "@/app/lib/logger";

/**
 * GET /api/cron/health-report — Mondays 12:00 UTC (see vercel.json).
 * Builds the weekly safety-net health check (backups, memory, AI spend, job
 * last-runs, flags, performance series) and queues it to ALERT_EMAIL_TO via
 * the Gmail outbox. CRON_SECRET bearer. Reads everything READ-ONLY; writes
 * only pm:mail-outbox (one entry) and pm:health-report:<date>.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Cron-health-report");

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const out = await runHealthReport({ email: true, record: true });
    log.info(`overall ${out.report.overall}; emailed ${out.emailed}; recorded ${out.recorded}${out.note ? `; ${out.note}` : ""}`);
    return NextResponse.json({ ok: true, ...out });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
