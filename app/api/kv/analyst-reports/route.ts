import { getRedis } from "@/app/lib/redis";
import { NextRequest, NextResponse } from "next/server";

/**
 * Analyst-report manifest storage. Mirrors the pm:attachments split:
 *   - pm:analyst-reports                       → this route (lightweight manifest)
 *   - pm:analyst-report-pdf:<id>               → /[id] route (base64 PDF dataUrl)
 *
 * The manifest holds per-(ticker, source) entries with the extracted JSON
 * from Anthropic + metadata. The PDF dataUrl lives outside the manifest so
 * the manifest blob stays small and unaffected by per-value size limits.
 *
 * Shape:
 *   { [TICKER]: { rbc?: ReportMeta; jpm?: ReportMeta } }
 *
 * Each ReportMeta is:
 *   { id, label, uploadedAt, hash, extracted: { rating?, target?, asOf?, thesis?, risks?, sectorView?, keyMetrics? } }
 */

const KEY = "pm:analyst-reports";

// Force-dynamic ensures the Inbox tab's "All Ingested Reports" table sees
// fresh data on every Refresh click — without this, Next's default route
// caching could serve a stale snapshot that doesn't include just-ingested
// reports.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(KEY);
    if (!raw) return NextResponse.json({ reports: {} });
    return NextResponse.json({ reports: JSON.parse(raw) });
  } catch (e) {
    console.error("Redis read error (analyst-reports):", e);
    return NextResponse.json({ reports: {} });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { reports } = await req.json();
    const redis = await getRedis();
    await redis.set(KEY, JSON.stringify(reports));
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("Redis write error (analyst-reports):", e);
    return NextResponse.json({ error: "Failed to save" }, { status: 500 });
  }
}
