import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const PERF_KEY = "pm:pim-performance";
const BACKUP_PREFIX = "pm:backup:";

/**
 * POST /api/admin/restore-pim-performance
 *
 * Body: { date?: string }  (YYYY-MM-DD; defaults to most recent available)
 *
 * Restores the pm:pim-performance blob from a nightly pm:backup:<date>
 * snapshot. One-shot recovery for the case where /api/pim-performance was
 * accidentally invoked and overwrote the carefully-accumulated daily
 * ledger with a Yahoo-derived recompute.
 *
 * Behavior:
 *   - GET /api/admin/restore-pim-performance: lists available backup
 *     dates and whether each has a pim-performance entry, plus a preview
 *     of the most-recent entry's lastUpdated and model count.
 *   - POST with no body / { date: null }: restores from the MOST RECENT
 *     backup that contains a pim-performance entry.
 *   - POST with { date: "YYYY-MM-DD" }: restores from that exact backup.
 *
 * Always backs up the current pm:pim-performance to pm:pim-performance.
 * pre-restore-<timestamp> first, so a botched restore is reversible.
 */

type BackupBlob = {
  backedUpAt: string;
  keyCount: number;
  totalBytes: number;
  data: Record<string, string>;
};

async function listBackupDates(redis: Awaited<ReturnType<typeof getRedis>>): Promise<string[]> {
  // Backup retention is 14 days (see /api/cron/backup-redis), so KEYS
  // returns at most ~14 entries — safe to use here.
  const keys = await redis.keys(`${BACKUP_PREFIX}*`);
  const dates: string[] = [];
  for (const k of keys) {
    const date = k.slice(BACKUP_PREFIX.length);
    if (/^\d{4}-\d{2}-\d{2}$/.test(date)) dates.push(date);
  }
  return dates.sort().reverse(); // newest first
}

export async function GET() {
  try {
    const redis = await getRedis();
    const dates = await listBackupDates(redis);
    const summary: Array<{ date: string; hasPerf: boolean; modelCount?: number; perfLastUpdated?: string }> = [];
    for (const date of dates.slice(0, 10)) {
      const raw = await redis.get(`${BACKUP_PREFIX}${date}`);
      if (!raw) { summary.push({ date, hasPerf: false }); continue; }
      const blob = JSON.parse(raw) as BackupBlob;
      const perfRaw = blob.data?.[PERF_KEY];
      if (!perfRaw) { summary.push({ date, hasPerf: false }); continue; }
      try {
        const perf = JSON.parse(perfRaw) as { models?: unknown[]; lastUpdated?: string };
        summary.push({
          date,
          hasPerf: true,
          modelCount: Array.isArray(perf.models) ? perf.models.length : undefined,
          perfLastUpdated: perf.lastUpdated,
        });
      } catch {
        summary.push({ date, hasPerf: false });
      }
    }
    return NextResponse.json({ backups: summary });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const requestedDate = typeof body?.date === "string" ? body.date.trim() : "";
    const redis = await getRedis();

    let chosenDate: string | null = null;
    let perfRaw: string | null = null;

    if (requestedDate) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
        return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
      }
      const raw = await redis.get(`${BACKUP_PREFIX}${requestedDate}`);
      if (!raw) return NextResponse.json({ error: `no backup for ${requestedDate}` }, { status: 404 });
      const blob = JSON.parse(raw) as BackupBlob;
      perfRaw = blob.data?.[PERF_KEY] || null;
      if (!perfRaw) return NextResponse.json({ error: `${requestedDate} backup has no ${PERF_KEY}` }, { status: 404 });
      chosenDate = requestedDate;
    } else {
      const dates = await listBackupDates(redis);
      for (const date of dates) {
        const raw = await redis.get(`${BACKUP_PREFIX}${date}`);
        if (!raw) continue;
        const blob = JSON.parse(raw) as BackupBlob;
        if (blob.data?.[PERF_KEY]) { perfRaw = blob.data[PERF_KEY]; chosenDate = date; break; }
      }
      if (!perfRaw) return NextResponse.json({ error: "no backup contains pm:pim-performance" }, { status: 404 });
    }

    // Stash the current (post-corruption) blob before overwriting so a
    // mistake is recoverable. Stored under a unique key — won't pollute
    // the canonical PERF_KEY namespace.
    const currentRaw = await redis.get(PERF_KEY);
    const stashKey = `${PERF_KEY}.pre-restore-${Date.now()}`;
    if (currentRaw) await redis.set(stashKey, currentRaw);

    await redis.set(PERF_KEY, perfRaw);

    let modelCount: number | undefined;
    let lastUpdated: string | undefined;
    try {
      const parsed = JSON.parse(perfRaw) as { models?: unknown[]; lastUpdated?: string };
      modelCount = Array.isArray(parsed.models) ? parsed.models.length : undefined;
      lastUpdated = parsed.lastUpdated;
    } catch { /* tolerate */ }

    return NextResponse.json({
      ok: true,
      restoredFrom: chosenDate,
      stashedCurrentTo: currentRaw ? stashKey : null,
      modelCount,
      lastUpdated,
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
