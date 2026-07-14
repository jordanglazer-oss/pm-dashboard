import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { checkInvariants, persistInvariantResult } from "@/app/lib/redis-invariants";
import { blobConfigured } from "@/app/lib/blob-store";
import { writeBackupBlob, pruneBackupBlobs } from "@/app/lib/backup-store";
import { pruneStashes } from "@/app/lib/stash-prune";
import { captureLiveHedgingSnapshot } from "@/app/lib/hedging";
import { refreshFactsetEstimates } from "@/app/lib/estimates-refresh";
import { refreshMarketRegime } from "@/app/lib/market-regime-refresh";
import { refreshTechnicals } from "@/app/lib/technicals-refresh";
import { rebuildThesisHealth } from "@/app/lib/thesis-health-refresh";
import { runAlertDigest } from "@/app/lib/alert-digest";

// This one nightly slot runs, IN ORDER:
//   backup → prune → hedging snapshot → FactSet estimates → market regime →
//   technicals/riskAlert → thesis health → alert digest → invariants
// The order is a dependency chain, not a preference: thesis health consumes
// both the fresh estimate revisions AND the fresh riskAlert, and the digest
// consumes all of it. Refreshing them in any other order would email alerts
// derived from a prior day's inputs.
//
// Every added step is best-effort and independently caught, and ALL of them run
// AFTER the backup is already written to Blob — so a Yahoo/FRED hiccup or a
// timeout can degrade a refresh but can never cost the backup.
export const maxDuration = 60;

// Dead pre-operation rollback stashes older than this are auto-purged each
// nightly run so Redis self-maintains and never creeps back toward OOM.
const STASH_RETENTION_DAYS = 14;

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
// Backups now live in Vercel Blob (durable, off-Redis, doesn't compete with
// live data for the 250 MB tier). Blob is cheap, so retention can be generous.
const BACKUP_RETENTION_DAYS = 30;

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

    // ── 3. Write this run's backup to Vercel Blob ───────────────────
    // Backups live in Blob now, NOT Redis: durable if Redis is ever lost,
    // and they can't OOM the live-data tier. Blob writes are independent of
    // Redis memory, so a full Redis no longer blocks the backup.
    if (!blobConfigured()) {
      return NextResponse.json(
        { ok: false, error: "BLOB_READ_WRITE_TOKEN not set — cannot write backup to Blob." },
        { status: 500 },
      );
    }
    const fileStamp = stamp.replace(/[:.]/g, "-"); // filesystem-safe
    const backupInfo = await writeBackupBlob(snapshot, fileStamp);

    // ── 4. Prune old Blob backups (retention) + purge any LEGACY Redis
    //       backups (pm:backup:* are now dead weight in Redis). ────────
    const prunedBlobs = await pruneBackupBlobs(BACKUP_RETENTION_DAYS);
    const legacyRedisBackups = await scanAll(redis, `${BACKUP_PREFIX}*`);
    for (const key of legacyRedisBackups) {
      try { await redis.del(key); } catch { /* DEL is OOM-safe; ignore */ }
    }
    const backupKey = backupInfo.pathname;
    const toDelete = prunedBlobs;

    // ── 4b. Auto-hygiene: purge dead rollback stashes (DEL-only, OOM-safe)
    //        so Redis self-maintains. Best-effort — never fail the backup. ──
    let stashesPurged = 0;
    try {
      const res = await pruneStashes(redis, { days: STASH_RETENTION_DAYS });
      stashesPurged = res.deleted.length;
    } catch (e) {
      console.error("[backup-redis] stash prune failed (backup still ok):", e);
    }

    // ── 4c. Capture today's SPY hedging snapshot ─────────────────────
    //        Piggybacks on the one daily cron slot (Hobby tier allows only
    //        one). Building the ledger daily — not just when the user opens
    //        the Hedging tab — is what makes week-over-week comparisons
    //        populate. Best-effort: a CBOE hiccup must not fail the backup. ──
    let hedgingSnapshot: { captured: true; date: string; totalSnapshots: number } | { captured: false; error: string };
    try {
      const res = await captureLiveHedgingSnapshot();
      hedgingSnapshot = { captured: true, date: res.date, totalSnapshots: res.totalSnapshots };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] Hedging snapshot capture failed (backup still ok):", msg);
      hedgingSnapshot = { captured: false, error: msg };
    }

    // ── 4c. Refresh lightweight FactSet analyst estimates ────────────
    //        Mean target price + analyst count + EPS FY+1 up/down revisions
    //        for every Portfolio/Watchlist holding, WITHOUT a rescore (~1-2
    //        batched FactSet calls). Keeps the Change Monitor revisions +
    //        analyst-consensus category fresh daily. Best-effort: a FactSet
    //        hiccup must not fail the backup. ──
    let estimatesRefresh:
      | { ran: true; tickerCount: number; resolvedCount: number; updatedCount: number; error?: string }
      | { ran: false; error: string };
    try {
      const res = await refreshFactsetEstimates();
      estimatesRefresh = { ran: true, tickerCount: res.tickerCount, resolvedCount: res.resolvedCount, updatedCount: res.updatedCount, error: res.error };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] FactSet estimates refresh failed (backup still ok):", msg);
      estimatesRefresh = { ran: false, error: msg };
    }

    // ── 4d. Rebuild the alert digest's INPUTS before computing it ────
    //        pm:market-regime (30-min cache) and pm:thesis-health (6h cache)
    //        only ever refreshed on a page load — at 06:00 UTC nobody is on the
    //        dashboard, so the digest was emailing alerts derived from a
    //        snapshot that could be a day old. Rebuild both here, in order,
    //        AFTER the FactSet estimates refresh (4c) — thesis-health consumes
    //        those revisions, so estimates → regime → thesis → digest.
    //        Both write ONLY regenerable cache keys. Best-effort: a Yahoo/FRED
    //        hiccup must not fail the backup OR block the digest (which then
    //        just runs on the previous snapshot, as it did before). ──
    let regimeRefresh: { ran: true; label: string; computedAt: string } | { ran: false; error: string };
    try {
      const r = await refreshMarketRegime();
      regimeRefresh = { ran: true, label: r.composite.label, computedAt: r.computedAt };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] market-regime refresh failed (digest will use the cached snapshot):", msg);
      regimeRefresh = { ran: false, error: msg };
    }

    // Technicals + riskAlert from fresh price history. Must run BEFORE
    // thesis-health (which consumes riskAlert) and before the digest (whose
    // TECHNICAL alerts key off riskAlert). This is the only step that writes
    // pm:stocks — see app/lib/technicals-refresh.ts for the safety design
    // (targeted-field merge into a RE-READ of the array, abort-on-degraded,
    // per-ticker skip on failure). The nightly Blob backup above is already a
    // fresh recovery point for pm:stocks, minutes old.
    let technicalsRefresh: Awaited<ReturnType<typeof refreshTechnicals>>;
    try {
      technicalsRefresh = await refreshTechnicals();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] technicals refresh failed (digest will use the cached riskAlerts):", msg);
      technicalsRefresh = { ran: false, considered: 0, updated: 0, failed: 0, error: msg };
    }

    let thesisRefresh:
      | { ran: true; broken: number; eroding: number; intact: number }
      | { ran: false; error: string };
    try {
      const t = await rebuildThesisHealth();
      thesisRefresh = { ran: true, ...t.counts };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] thesis-health rebuild failed (digest will use the cached verdicts):", msg);
      thesisRefresh = { ran: false, error: msg };
    }

    // ── 4e. Proactive alert digest (Phase 07) ────────────────────────
    //        Compute today's "needs your attention" digest from the signals
    //        just refreshed above, append a snapshot to the append-only
    //        pm:alert-log, and email it IF a recipient is configured AND there
    //        are high-priority alerts. Best-effort: must not fail the backup. ──
    let alertDigest: { ran: boolean; total: number; emailed: boolean; error?: string };
    try {
      alertDigest = await runAlertDigest();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[backup-redis] Alert digest failed (backup still ok):", msg);
      alertDigest = { ran: false, total: 0, emailed: false, error: msg };
    }

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
      target: "blob",
      backupKey,
      backupUrl: backupInfo.url,
      keyCount: snapshot.keyCount,
      totalBytes: snapshot.totalBytes,
      prunedBlobBackups: toDelete,
      purgedLegacyRedisBackups: legacyRedisBackups.length,
      stashesPurged,
      hedgingSnapshot,
      estimatesRefresh,
      regimeRefresh,
      technicalsRefresh,
      thesisRefresh,
      alertDigest,
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
