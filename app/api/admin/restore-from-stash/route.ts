import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const PERF_KEY = "pm:pim-performance";
const APPENDIX_KEY = "pm:appendix-daily-values";

/**
 * Rollback endpoint for previously imported daily values.
 *
 * GET  /api/admin/restore-from-stash
 *   Lists recent stash keys (last ~20 of each type) with metadata.
 *   Used by the SIA Import UI to populate a rollback picker.
 *
 * POST /api/admin/restore-from-stash
 *   Body: { timestamp?: number, dryRun?: boolean }
 *   Restores pm:pim-performance and pm:appendix-daily-values to the
 *   contents of the corresponding *.pre-import-<timestamp> keys.
 *
 *   When timestamp is omitted, restores from the MOST RECENT stash.
 *
 *   Before restoring, the CURRENT live blobs are stashed to
 *   *.pre-rollback-<currentTs> keys so a rollback is itself
 *   reversible (rollback-the-rollback works).
 *
 *   dryRun defaults to TRUE — user must explicitly pass dryRun:false.
 */

type StashEntry = {
  timestamp: number;
  perfKey: string | null;
  appendixKey: string | null;
  perfSizeBytes?: number;
  appendixSizeBytes?: number;
  complete?: boolean;
};

async function listStashes(): Promise<StashEntry[]> {
  const redis = await getRedis();
  // Match both pre-import and pre-anchor stashes (they all represent
  // user-triggered modifications to performance data).
  const perfPattern = `${PERF_KEY}.pre-import-*`;
  const appendixPattern = `${APPENDIX_KEY}.pre-import-*`;
  const [perfKeys, appendixKeys] = await Promise.all([
    redis.keys(perfPattern),
    redis.keys(appendixPattern),
  ]);

  // Group by timestamp.
  const byTs = new Map<number, StashEntry>();
  const extractTs = (key: string): number | null => {
    const m = /\.pre-import-(\d+)$/.exec(key);
    return m ? parseInt(m[1], 10) : null;
  };

  for (const k of perfKeys) {
    const ts = extractTs(k);
    if (ts == null) continue;
    const existing = byTs.get(ts) ?? { timestamp: ts, perfKey: null, appendixKey: null };
    existing.perfKey = k;
    byTs.set(ts, existing);
  }
  for (const k of appendixKeys) {
    const ts = extractTs(k);
    if (ts == null) continue;
    const existing = byTs.get(ts) ?? { timestamp: ts, perfKey: null, appendixKey: null };
    existing.appendixKey = k;
    byTs.set(ts, existing);
  }

  const entries = [...byTs.values()].sort((a, b) => b.timestamp - a.timestamp);
  // Fetch size info for the most recent 20.
  const recent = entries.slice(0, 20);
  await Promise.all(
    recent.map(async (e) => {
      if (e.perfKey) {
        const raw = await redis.get(e.perfKey);
        e.perfSizeBytes = raw?.length;
      }
      if (e.appendixKey) {
        const raw = await redis.get(e.appendixKey);
        e.appendixSizeBytes = raw?.length;
      }
    }),
  );
  return recent;
}

export async function GET() {
  try {
    const stashes = await listStashes();
    return NextResponse.json({
      stashes: stashes.map((s) => ({
        timestamp: s.timestamp,
        date: new Date(s.timestamp).toISOString(),
        perfKey: s.perfKey,
        appendixKey: s.appendixKey,
        perfSizeBytes: s.perfSizeBytes ?? null,
        appendixSizeBytes: s.appendixSizeBytes ?? null,
        complete: !!(s.perfKey && s.appendixKey),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const dryRun = body?.dryRun !== false;
    let timestamp: number | null = typeof body?.timestamp === "number" ? body.timestamp : null;

    const stashes = await listStashes();
    if (stashes.length === 0) {
      return NextResponse.json({ error: "no stashes available to restore from" }, { status: 404 });
    }

    if (timestamp == null) {
      // Use the most recent.
      timestamp = stashes[0].timestamp;
    }
    const target = stashes.find((s) => s.timestamp === timestamp);
    if (!target) {
      return NextResponse.json(
        { error: `no stash found for timestamp ${timestamp}`, availableTimestamps: stashes.map((s) => s.timestamp) },
        { status: 404 },
      );
    }
    if (!target.perfKey || !target.appendixKey) {
      return NextResponse.json(
        { error: `stash for ${timestamp} is incomplete (missing perf or appendix half)`, target },
        { status: 400 },
      );
    }

    const redis = await getRedis();
    const [stashedPerf, stashedAppendix] = await Promise.all([
      redis.get(target.perfKey as string),
      redis.get(target.appendixKey as string),
    ]);
    if (!stashedPerf || !stashedAppendix) {
      return NextResponse.json({ error: "stash data missing from Redis (key exists but value empty)" }, { status: 500 });
    }

    if (dryRun) {
      // Just verify the stashes are loadable and return a summary.
      return NextResponse.json({
        ok: true,
        dryRun: true,
        wrote: false,
        target: {
          timestamp: target.timestamp,
          date: new Date(target.timestamp).toISOString(),
          perfKey: target.perfKey,
          appendixKey: target.appendixKey,
          perfSizeBytes: stashedPerf.length,
          appendixSizeBytes: stashedAppendix.length,
        },
        note: "dryRun=true — no data written. Re-run with dryRun:false to actually restore.",
      });
    }

    // ─── WRITE PATH ───
    // Stash the CURRENT (about-to-be-overwritten) blobs first so the
    // rollback is itself reversible.
    const rollbackTs = Date.now();
    const [currentPerf, currentAppendix] = await Promise.all([
      redis.get(PERF_KEY),
      redis.get(APPENDIX_KEY),
    ]);
    if (currentPerf) await redis.set(`${PERF_KEY}.pre-rollback-${rollbackTs}`, currentPerf);
    if (currentAppendix) await redis.set(`${APPENDIX_KEY}.pre-rollback-${rollbackTs}`, currentAppendix);

    await redis.set(PERF_KEY, stashedPerf);
    await redis.set(APPENDIX_KEY, stashedAppendix);

    return NextResponse.json({
      ok: true,
      dryRun: false,
      wrote: true,
      restoredFrom: {
        timestamp: target.timestamp,
        date: new Date(target.timestamp).toISOString(),
        perfKey: target.perfKey,
        appendixKey: target.appendixKey,
      },
      preRollbackStashKeys: {
        perf: currentPerf ? `${PERF_KEY}.pre-rollback-${rollbackTs}` : null,
        appendix: currentAppendix ? `${APPENDIX_KEY}.pre-rollback-${rollbackTs}` : null,
      },
      note: "Restored. Pre-rollback values are stashed under the keys above — if you need to undo this rollback, restore from those.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
