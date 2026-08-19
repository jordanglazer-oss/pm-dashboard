import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { runSetupScan, SCAN_KEY, type RunOpts } from "@/app/lib/setup-scan-core";

export const maxDuration = 60;

/**
 * POST /api/setup-scan — run one slice of the setup scan.
 * GET  /api/setup-scan — read the stored result.
 *
 * All the logic lives in setup-scan-core so this and the nightly cron cannot
 * drift apart. See that file for why the scan is sliced rather than swept.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as RunOpts & { dryRun?: boolean };
  const redis = await getRedis();
  const result = await runSetupScan(redis, {
    tickers: Array.isArray(body.tickers) ? body.tickers : undefined,
    universe: body.universe,
    limit: body.limit,
    full: body.full,
  });
  if (result.requested === 0) {
    return NextResponse.json({ ok: false, error: "No tickers to scan.", ...result }, { status: 400 });
  }
  // Cap the payload; the store keeps everything.
  return NextResponse.json({ ...result, rows: result.rows.slice(0, 150) });
}

export async function GET() {
  try {
    const raw = await (await getRedis()).get(SCAN_KEY);
    return NextResponse.json(raw ? JSON.parse(raw) : { rows: [], generatedAt: null });
  } catch {
    return NextResponse.json({ rows: [], generatedAt: null });
  }
}
