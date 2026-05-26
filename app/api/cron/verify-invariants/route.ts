/**
 * Standalone Redis invariant check endpoint.
 *
 * In production this is no longer scheduled separately — the daily check
 * is folded into /api/cron/backup-redis (it runs inline right after the
 * snapshot writes). Vercel Hobby tier only allows one cron, so chaining
 * onto the existing backup keeps both safety nets running on Hobby.
 *
 * This route remains for:
 *   - Manual ad-hoc checks ("did anything drift since the last backup?")
 *     via authenticated curl
 *   - Upgrading to Vercel Pro later — just add a separate cron entry
 *     pointing here at a different time (e.g. mid-day check)
 *
 * Logic lives in app/lib/redis-invariants.ts so the backup route can
 * reuse it byte-identically. See that file for the list of checks.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { checkInvariants, persistInvariantResult } from "@/app/lib/redis-invariants";

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json(
      { error: "CRON_SECRET env var not configured" },
      { status: 500 },
    );
  }
  const authHeader = req.headers.get("authorization");
  if (authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const redis = await getRedis();
    const violations = await checkInvariants(redis);
    const alertKey = await persistInvariantResult(redis, violations);
    return NextResponse.json({
      ok: true,
      status: violations.length > 0 ? "violations-found" : "healthy",
      count: violations.length,
      alertKey,
      violations,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Invariant check failed" },
      { status: 500 },
    );
  }
}
