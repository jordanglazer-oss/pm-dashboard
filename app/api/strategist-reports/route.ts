import { NextRequest, NextResponse } from "next/server";
import { getStrategistReport, listStrategistReports } from "@/app/lib/strategist-reports";
import { createLogger } from "@/app/lib/logger";

const log = createLogger("Strategist-reports");

/**
 * GET /api/strategist-reports          → every report on file, newest first
 *                                        (facts + summaries, no full text)
 * GET /api/strategist-reports?id=<id>  → one report with its full text
 *
 * READ-ONLY. Reports are filed only by the email ingest; there is
 * deliberately no client write path.
 */
export async function GET(req: NextRequest) {
  const id = new URL(req.url).searchParams.get("id");
  try {
    if (id) {
      const report = await getStrategistReport(id);
      if (!report) return NextResponse.json({ error: "Not found" }, { status: 404 });
      return NextResponse.json({ report });
    }
    return NextResponse.json({ reports: await listStrategistReports() });
  } catch (e) {
    log.error("read failed:", e);
    return id ? NextResponse.json({ error: "Read failed" }, { status: 500 }) : NextResponse.json({ reports: [] });
  }
}
