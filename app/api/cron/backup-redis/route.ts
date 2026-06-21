import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { checkInvariants, persistInvariantResult } from "@/app/lib/redis-invariants";

/**
 * Daily Redis snapshot backup + invariant check.
 *
 * Runs at 06:00 UTC (~2 AM ET) via Vercel cron — see vercel.json. Vercel
 * Hobby tier allows only one cron entry running once per day, so this
 * route does double duty: backup first, then invariant check inline. If
 * we ever upgrade to Pro we can split them onto their own schedules; the
 * invariant logic lives in app/lib/redis-invariants.ts and is re-exported
 * by /api/cron/verify-invariants for ad-hoc use.
 *
 * What it does:
 *   1. SCANs every `pm:*` key (except ephemeral ones we don't care about).
 *   2. Serializes the full {key → value} map into a single JSON blob.
 *   3. Writes it to `pm:backup:YYYY-MM-DDTHH:00:00Z` (ISO timestamp prefix
 *      so multi-time-of-day cadence — if we upgrade to Pro — doesn't
 *      overwrite earlier runs).
 *   4. Prunes backups older than BACKUP_RETENTION_DAYS.
 *   5. Runs the structural invariant check. Writes any violations to
 *      pm:invariant-alerts:YYYY-MM-DD, or clears that key on healthy run.
 *      The check is best-effort: if it throws, we log but still return
 *      success for the backup (the backup is the critical path).
 *
 * Key format note: this route used to write `pm:backup:YYYY-MM-DD` (date
 * only). Legacy date-only keys are still readable and still get pruned by
 * the cutoff logic below (Date.parse handles both formats). Restore
 * scripts that look up a specific date should now include the hour.
 *
 * Restore procedure (manual, run from a one-off script):
 *   // List recent backups:
 *   //   const keys = await redis.keys("pm:backup:*");
 *   const raw = await redis.get("pm:backup:2026-05-26T06:00:00Z");
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
// Retention is capped tight because the Redis Essentials tier is only
// 250 MB and each full-keyspace backup is ~10-12 MB. 60-day retention
// (the old value, set after the 2026-05-25 incident) accumulated
// >130 MB of snapshots and twice drove the instance OOM, blocking all
// writes. 5 days of daily backups (~60 MB) is a sane recovery window for
// this tier; risky operations also stash their own pre-image, and the
// PM takes a manual backup-now before big changes. Bump this back up only
// if the storage tier is upgraded.
const BACKUP_RETENTION_DAYS = 5;

// Keys we intentionally do NOT back up:
//   - pm:backup:*         previous backups (would recursively bloat)
//   - pm:ratelimit:*      ephemeral, auto-expires in 60s
//   - pm:fund-data-cache  large, deterministically re-fetchable from Morningstar
// MUST stay in sync with app/api/admin/backup-now/route.ts. The cron used
// to exclude only backup/ratelimit/fund-data-cache, so it backed up the
// ~70MB of analyst PDFs in EVERY snapshot — the June 4 cron backup was 98MB
// (vs backup-now's 11.8MB), which is what filled the 250MB tier. Excluding
// the bulky re-obtainable blobs + regenerable caches keeps each snapshot
// ~12MB so 5-day retention fits comfortably. A restore brings back all the
// core structured data (stocks/models/positions/research/scores/manifests/
// settings); the excluded PDFs/screenshots are re-uploaded and the caches /
// derived performance regenerate on their own.
const EXCLUDE_PATTERNS = [
  /^pm:backup:/,             // never back up backups (recursive bloat)
  /^pm:ratelimit:/,          // ephemeral, auto-expires
  // ── Regenerable caches (CLAUDE.md: "Pure cache. Safe to nuke.") ──
  /^pm:fund-data-cache/,
  /^pm:fund-data-negative:/,
  /^pm:edgar-/,              // edgar-facts / -submissions / -form4 / -ticker-map (~110MB)
  /^pm:market-regime$/,
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

/**
 * Hour-truncated ISO timestamp (e.g. "2026-05-26T14:00:00Z"). Used as the
 * backup key suffix so the three daily runs (06/14/22 UTC) produce three
 * distinct keys per day instead of overwriting each other.
 */
function backupStampUTC(): string {
  const now = new Date();
  // Truncate to the hour: YYYY-MM-DDTHH:00:00Z
  return `${now.toISOString().slice(0, 13)}:00:00Z`;
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

    const stamp = backupStampUTC();
    const snapshot = {
      backedUpAt: new Date().toISOString(),
      keyCount: Object.keys(data).length,
      totalBytes,
      data,
    };

    // ── 3. Prune old backups FIRST (before writing) ─────────────────
    // Critical ordering: prune-then-write, NOT write-then-prune. On a
    // memory-constrained tier the new backup's redis.set throws
    // "OOM command not allowed" when the instance is full — and if the
    // prune ran AFTER the write, that throw would skip the prune, leaving
    // memory full so EVERY subsequent nightly run fails the same way (a
    // silent death spiral — exactly what happened June 4 → June 21). By
    // pruning expired backups first, each run reclaims space before it
    // needs it, so the write succeeds and the cron self-heals. DEL is
    // permitted even when OOM, so this works in the stuck state too.
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

    // ── 4. Write this run's backup ──────────────────────────────────
    const backupKey = `${BACKUP_PREFIX}${stamp}`;
    await redis.set(backupKey, JSON.stringify(snapshot));

    // ── 5. Run invariant check inline ────────────────────────────────
    // Best-effort: a thrown invariant check must not turn a successful
    // backup into a failed response. We log + carry on if it errors.
    let invariantSummary:
      | { ran: true; status: "healthy" | "violations-found"; count: number; alertKey: string }
      | { ran: false; error: string };
    try {
      const violations = await checkInvariants(redis);
      const alertKey = await persistInvariantResult(redis, violations);
      invariantSummary = {
        ran: true,
        status: violations.length > 0 ? "violations-found" : "healthy",
        count: violations.length,
        alertKey,
      };
      if (violations.length > 0) {
        console.warn("[backup-redis] Invariant violations:", JSON.stringify(violations));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] Invariant check threw (backup itself succeeded):", msg);
      invariantSummary = { ran: false, error: msg };
    }

    return NextResponse.json({
      ok: true,
      backupKey,
      keyCount: snapshot.keyCount,
      totalBytes: snapshot.totalBytes,
      pruned: toDelete,
      invariantCheck: invariantSummary,
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
