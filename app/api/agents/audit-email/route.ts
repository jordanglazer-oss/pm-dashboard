import { NextResponse } from "next/server";
import { listFlags } from "@/app/lib/agents/flags";
import { auditSince, buildAuditEmail } from "@/app/lib/agents/flag-mail";

/**
 * GET /api/agents/audit-email — PREVIEW of tonight's end-of-day audit email
 * (what it would say if it went out now). Read-only: queues nothing, moves
 * no marker. The real send is the last step of /api/cron/stance-watch.
 */

export const dynamic = "force-dynamic";

export async function GET() {
  const email = buildAuditEmail(await listFlags(), await auditSince());
  return NextResponse.json({ mode: "PREVIEW — nothing sent", to: process.env.ALERT_EMAIL_TO ? "ALERT_EMAIL_TO is set" : "ALERT_EMAIL_TO is NOT set — no email would go out", ...email });
}
