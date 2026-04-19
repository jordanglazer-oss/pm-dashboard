import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Nightly Redis snapshot backup.
 *
 * Runs at 06:00 UTC (≈ 2 AM ET) via Vercel cron — see vercel.json.
 *
 * What it does:
 *   1. SCANs every `pm:*` key (except ephemeral ones we don't care about).
 *   2. Serializes the full {key → value} map into a single JSON blob.
 *   3. Writes it to `pm:backup:YYYY-MM-DD`.
 *   4. Prunes backups older than BACKUP_RETENTION_DAYS.
 *
 * Restore procedure (manual, run from a one-off script):
 *   const raw = await redis.get("pm:backup:2026-04-18");
 *   const snapshot = JSON.parse(raw);
 *   for (const [key, value] of Object.entries(snapshot.data)) {
 *     await redis.set(key, value as string);
 *   }
 *
 * Security: Vercel cron includes `Authorization: Bearer $CRON_SECRET` when
 * CRON_SECRET is set. This route verifies that header and rejects anything
 * else with 401. The /api/cron/* path is also exempted from the auth-cookie
 * middleware so Vercel's cron runner (which has no cookie) can reach it.
 */

const BACKUP_PREFIX = "pm:backup:";
const BACKUP_RETENTION_DAYS = 14;

// Keys we intentionally do NOT back up:
//   - pm:backup:*         previous backups (would recursively bloat)
//   - pm:ratelimit:*      ephemeral, auto-expires in 60s
//   - pm:fund-data-cache  large, deterministically re-fetchable from Morningstar
const EXCLUDE_PATTERNS = [
  /^pm:backup:/,
  /^pm:ratelimit:/,
  /^pm:fund-data-cache/,
];

function shouldExclude(key: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(key));
}

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Scan all keys matching a pattern. Uses SCAN (not KEYS) so it stays safe
 *  even if the keyspace grows. */
async function scanAll(
  redis: Awaited<ReturnType<typeof getRedis>>,
  match: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    // scanIterator can yield either string or string[] depending on client version
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

export async function GET(req: NextRequest) {
  // ── Auth ──────────────────────────────────────────────────────────
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

  const startedAt = Date.now();
  try {
    const redis = await getRedis();

    // ── 1. Collect all user-data keys ───────────────────────────────
    const allKeys = await scanAll(redis, "pm:*");
    const backupKeys = allKeys.filter((k) => !shouldExclude(k));

    if (backupKeys.length === 0) {
      return NextResponse.json(
        { ok: false, warning: "No pm:* keys found to back up — refusing to write empty backup" },
        { status: 200 },
      );
    }

    // ── 2. Snapshot every value ─────────────────────────────────────
    // Sequential reads keep the code simple; ~20 keys finishes in ms.
    // If this ever grows, batch with MGET.
    const data: Record<string, string> = {};
    let totalBytes = 0;
    for (const key of backupKeys) {
      const value = await redis.get(key);
      if (value != null) {
        data[key] = value;
        totalBytes += value.length;
      }
    }

    const today = todayUTC();
    const snapshot = {
      backedUpAt: new Date().toISOString(),
      keyCount: Object.keys(data).length,
      totalBytes,
      data,
    };

    // ── 3. Write today's backup ─────────────────────────────────────
    const backupKey = `${BACKUP_PREFIX}${today}`;
    await redis.set(backupKey, JSON.stringify(snapshot));

    // ── 4. Prune old backups ────────────────────────────────────────
    const existingBackups = await scanAll(redis, `${BACKUP_PREFIX}*`);
    const cutoffMs = Date.now() - BACKUP_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const toDelete: string[] = [];
    for (const key of existingBackups) {
      const dateStr = key.slice(BACKUP_PREFIX.length);
      const t = Date.parse(dateStr);
      if (Number.isFinite(t) && t < cutoffMs) toDelete.push(key);
    }
    for (const key of toDelete) {
      await redis.del(key);
    }

    return NextResponse.json({
      ok: true,
      backupKey,
      keyCount: snapshot.keyCount,
      totalBytes: snapshot.totalBytes,
      pruned: toDelete,
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error("Redis backup failed:", e);
    return NextResponse.json(
      { error: "Backup failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
