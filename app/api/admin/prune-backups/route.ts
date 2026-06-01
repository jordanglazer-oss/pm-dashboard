import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Free Redis memory by deleting old pm:backup:* snapshots ONLY.
 *
 * SAFETY: this endpoint can ONLY ever delete keys matching the literal
 * prefix "pm:backup:". It never touches user data (pm:stocks,
 * pm:pim-models, pm:research, pm:attachment:*, etc.). DEL is permitted even
 * when the instance is OOM, so this is the recovery path for the
 * "OOM command not allowed" error caused by accumulated full-keyspace
 * backup blobs.
 *
 * Behavior:
 *   - ?confirm=YES is REQUIRED (destructive on backup keys).
 *   - ?keep=N (default 3) retains the N most-recent backups (by the ISO
 *     timestamp in the key) and deletes the older ones. keep=0 deletes ALL
 *     backups (use when you're about to take a fresh one and need max room).
 *   - Reports which backups were kept vs deleted and the bytes freed.
 */

const BACKUP_PREFIX = "pm:backup:";

async function scanAll(
  redis: Awaited<ReturnType<typeof getRedis>>,
  match: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to delete old backups. Optional &keep=N (default 3) keeps the N most-recent backups. Only pm:backup:* keys are ever touched.",
      },
      { status: 400 },
    );
  }
  const keepRaw = parseInt(params.get("keep") ?? "3", 10);
  const keep = Number.isFinite(keepRaw) && keepRaw >= 0 ? keepRaw : 3;

  const startedAt = Date.now();
  try {
    const redis = await getRedis();

    const backupKeys = await scanAll(redis, `${BACKUP_PREFIX}*`);
    // Hard guard: refuse to act on anything that isn't a backup key.
    const safeKeys = backupKeys.filter((k) => k.startsWith(BACKUP_PREFIX));

    // Sort newest-first by the timestamp embedded after the prefix.
    const sorted = [...safeKeys].sort((a, b) => {
      const ta = Date.parse(a.slice(BACKUP_PREFIX.length));
      const tb = Date.parse(b.slice(BACKUP_PREFIX.length));
      const va = Number.isFinite(ta) ? ta : 0;
      const vb = Number.isFinite(tb) ? tb : 0;
      return vb - va;
    });

    const kept = sorted.slice(0, keep);
    const toDelete = sorted.slice(keep);

    let freedBytes = 0;
    const deleted: string[] = [];
    for (const key of toDelete) {
      // Double-check the prefix right before deleting — defense in depth.
      if (!key.startsWith(BACKUP_PREFIX)) continue;
      try {
        freedBytes += await redis.strLen(key);
      } catch {
        /* size best-effort */
      }
      await redis.del(key);
      deleted.push(key);
    }

    return NextResponse.json({
      ok: true,
      keep,
      keptCount: kept.length,
      kept,
      deletedCount: deleted.length,
      deleted,
      freedBytes,
      freedMB: +(freedBytes / 1e6).toFixed(2),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error("[prune-backups] failed:", e);
    return NextResponse.json(
      { error: "Prune failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
