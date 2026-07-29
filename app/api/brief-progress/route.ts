import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { BRIEF_PROGRESS_KEY, type BriefProgress } from "@/app/lib/brief-progress-shared";

/**
 * GET /api/brief-progress?runId=… — poll target for the generation modal.
 * Returns the progress blob only when it belongs to the asked-about run, so a
 * stale blob from a previous generation can never render as live progress.
 * Read-only; empty on any error (progress is cosmetic, never a failure path).
 */

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const runId = new URL(req.url).searchParams.get("runId") || "";
    if (!runId) return NextResponse.json({ progress: null });
    const redis = await getRedis();
    const raw = await redis.get(BRIEF_PROGRESS_KEY);
    if (!raw) return NextResponse.json({ progress: null });
    const blob = JSON.parse(raw) as BriefProgress;
    return NextResponse.json({ progress: blob.runId === runId ? blob : null });
  } catch {
    return NextResponse.json({ progress: null });
  }
}
