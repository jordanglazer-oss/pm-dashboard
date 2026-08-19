import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { runSetupScan } from "@/app/lib/setup-scan-core";

export const maxDuration = 60;

/**
 * GET /api/cron/setup-scan — keep the setup readings current without anyone
 * pressing a button.
 *
 * Runs several SLICES back to back within one invocation, pausing between them
 * so Yahoo's datacentre-IP limiter has room to recover. That is the whole
 * reason slices exist: from Vercel a single burst of ninety bar requests is
 * refused no matter how it is paced, but a few smaller batches separated in
 * time get through.
 *
 * Scheduled twice nightly rather than once. One pass at 25-a-slice will not
 * always finish a growing candidate list, and a scan that silently stops
 * three-quarters done is the failure mode this endpoint exists to avoid — the
 * second run picks up whatever the first could not, reusing everything already
 * read.
 *
 * Reads price bars, writes pm:setup-scan. Nothing else.
 */

const SLICES_PER_RUN = 4;
const PAUSE_BETWEEN_SLICES_MS = 3_000;
const DEADLINE_MS = 52_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const redis = await getRedis();
  const passes: { fetched: number; failed: number; remaining: number }[] = [];

  for (let i = 0; i < SLICES_PER_RUN; i++) {
    if (Date.now() - startedAt > DEADLINE_MS) break;
    const r = await runSetupScan(redis, { universe: "suggested", limit: 25, startedAt });
    passes.push({ fetched: r.fetched, failed: r.failed, remaining: r.remaining });
    // Nothing left, or the slice achieved nothing (fully throttled) — either
    // way another immediate attempt is not going to help.
    if (r.remaining === 0 || r.fetched === 0) break;
    if (i < SLICES_PER_RUN - 1) await sleep(PAUSE_BETWEEN_SLICES_MS);
  }

  const last = passes[passes.length - 1];
  return NextResponse.json({
    ok: true,
    passes,
    remaining: last?.remaining ?? null,
    elapsedMs: Date.now() - startedAt,
  });
}
