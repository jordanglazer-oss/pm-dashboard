import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { blobConfigured } from "@/app/lib/blob-store";
import { writeBackupBlob } from "@/app/lib/backup-store";

/**
 * On-demand, purely-additive Redis backup.
 *
 * Unlike the scheduled /api/cron/backup-redis route (which requires the
 * CRON_SECRET bearer header and also prunes + runs invariant checks), this
 * endpoint exists so the PM can trigger a manual snapshot from the browser
 * BEFORE a risky change. It lives under /api/admin/* which is gated by the
 * auth-cookie middleware, so only a logged-in session can reach it.
 *
 * Safety properties (deliberate):
 *   - READS every pm:* key (except the excluded ephemeral/derivable ones)
 *     and WRITES a single new snapshot at pm:backup:<full-ISO-timestamp>.
 *   - Deletes NOTHING. No pruning, no invariant writes, no mutation of any
 *     existing key. The worst case is one extra backup blob in Redis.
 *   - Requires ?confirm=YES so an accidental prefetch / link-scan can't fire
 *     it (even though it's non-destructive).
 *
 * Restore is identical to the cron backups: read the backup snapshot, then
 * redis.set(key, value) for each entry in snapshot.data.
 */

// The backup is a SINGLE JSON value, so it must stay small enough to write
// on a memory-constrained instance. We therefore exclude (a) regenerable
// caches and (b) bulky binary uploads that are independently restorable and
// unaffected by model/score logic. What remains is the hand-entered /
// computed state that actually matters for a revert: pm:stocks,
// pm:pim-models, pm:research, positions, snapshots, history, etc.
const EXCLUDE_PATTERNS = [
  /^pm:backup:/,             // never back up backups (recursive bloat)
  /^pm:ratelimit:/,          // ephemeral, auto-expires
  // ── Regenerable caches (CLAUDE.md: "Pure cache. Safe to nuke.") ──
  /^pm:fund-data-cache/,
  /^pm:fund-data-negative:/,
  /^pm:edgar-/,              // edgar-facts / -submissions / -form4 / -ticker-map (~110MB)
  /^pm:market-regime$/,
  /^pm:catalyst-calendar$/,  // Phase 01 cache (rebuilds from pm:stocks + FRED)
  /^pm:thesis-health$/,      // Phase 03 cache (rebuilds from score-history + snapshots)
  /-cache$/,                 // *-analysis-cache, *-scrape-cache (hash-gated)
  /-scrape-cache:/,
  // ── Derived (recomputed from daily values + models) ──
  /^pm:pim-performance/,     // includes .pre-* migration stashes
  // ── Bulky binary uploads — separately restorable, not model/score data ──
  /^pm:analyst-report-pdf:/, // 70MB of uploaded PDFs
  /^pm:attachment:/,         // base64 screenshots/PDFs (the per-file keys)
  // NOTE: pm:attachments (the lightweight manifest, no trailing colon) is
  // intentionally KEPT — it's tiny and lists which files exist.
];

function shouldExclude(key: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(key));
}

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
  if (req.nextUrl.searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to run a manual backup. This is read-only except for writing one new pm:backup:* snapshot — it deletes nothing.",
      },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  try {
    const redis = await getRedis();

    const allKeys = await scanAll(redis, "pm:*");
    const backupKeys = allKeys.filter((k) => !shouldExclude(k));

    if (backupKeys.length === 0) {
      return NextResponse.json(
        { ok: false, warning: "No pm:* keys found to back up — refusing to write empty backup" },
        { status: 200 },
      );
    }

    const data: Record<string, string> = {};
    let totalBytes = 0;
    for (const key of backupKeys) {
      const value = await redis.get(key);
      if (value != null) {
        data[key] = value;
        totalBytes += value.length;
      }
    }

    const stamp = new Date().toISOString();
    const snapshot = {
      backedUpAt: stamp,
      keyCount: Object.keys(data).length,
      totalBytes,
      data,
    };

    // Write to Vercel Blob (durable, off-Redis). Additive — deletes nothing.
    if (!blobConfigured()) {
      return NextResponse.json(
        { ok: false, error: "BLOB_READ_WRITE_TOKEN not set — cannot write backup to Blob." },
        { status: 500 },
      );
    }
    const fileStamp = stamp.replace(/[:.]/g, "-"); // filesystem-safe
    const info = await writeBackupBlob(snapshot, fileStamp);

    return NextResponse.json({
      ok: true,
      target: "blob",
      backupKey: info.pathname,
      backupUrl: info.url,
      keyCount: snapshot.keyCount,
      totalBytes: snapshot.totalBytes,
      keys: backupKeys.sort(),
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error("[backup-now] manual backup failed:", e);
    return NextResponse.json(
      { error: "Backup failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
