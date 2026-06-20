import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Read-only diagnostic. Returns the last 10 writes to pm:stocks, written
 * by the tracer in app/api/kv/stocks/route.ts. Each entry has:
 *   - at: ISO timestamp
 *   - userAgent / forwardedFor / referer: who sent the PUT
 *   - bucketCounts + avgoBucket + orclBucket: shape of the payload
 *
 * Used to find what's reverting AVGO/ORCL back to Watchlist between
 * recovery-endpoint runs.
 */

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:stocks-write-trace");
    if (!raw) {
      return NextResponse.json({
        ok: true,
        writes: [],
        note: "No writes recorded yet (the tracer was just deployed). Wait for the next pm:stocks write and call again.",
      });
    }
    const writes = JSON.parse(raw);
    return NextResponse.json({
      ok: true,
      readAt: new Date().toISOString(),
      writes,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
