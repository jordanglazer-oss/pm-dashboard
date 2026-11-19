import { NextResponse } from "next/server";
import { buildHealthReport, formatHealthEmail } from "@/app/lib/health-report";
import { createLogger } from "@/app/lib/logger";

/**
 * GET /api/admin/health-report — the weekly health check on demand, as JSON.
 * READ-ONLY: writes nothing, emails nothing. Includes `emailPreview` (the
 * exact subject + text the Monday email would carry). Auth-cookie gated by
 * middleware like every /api/admin route.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Health-report");

export async function GET() {
  try {
    const report = await buildHealthReport();
    return NextResponse.json({ ok: true, report, emailPreview: formatHealthEmail(report) });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
