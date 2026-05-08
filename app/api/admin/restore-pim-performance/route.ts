import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimPerformanceData, PimModelPerformance, AppendixData, AppendixModelLedger, PimProfileType } from "@/app/lib/pim-types";

const PERF_KEY = "pm:pim-performance";
const APPENDIX_KEY = "pm:appendix-daily-values";
const BACKUP_PREFIX = "pm:backup:";

/**
 * POST /api/admin/restore-pim-performance/from-appendix
 *
 * Rebuilds the PIM group's series in pm:pim-performance from the
 * immutable pm:appendix-daily-values ledger. Mirrors the client-side
 * seedFromAppendix flow in PimPerformance.tsx but runs server-side
 * and unconditionally — useful when the existing pm:pim-performance
 * blob was overwritten by a bad recompute and the auto-corruption
 * check in the client didn't trip.
 *
 * Scope: only restores groupId === "pim". The Appendix has no
 * per-group dimension, so non-PIM series (pc-usa, non-res, ey,
 * kpmg, deloitte, rcgt) cannot be recovered from this endpoint.
 *
 * Side-effects:
 *   - Stashes current pm:pim-performance to pm:pim-performance.
 *     pre-restore-<timestamp> first.
 *   - Preserves all non-PIM series in pm:pim-performance unchanged.
 *   - For PIM series: replaces history with appendix entries, but
 *     keeps any post-provider entries (dates after the appendix's
 *     last entry) so live-tracked recent days don't get dropped.
 */
async function restoreFromAppendix(redis: Awaited<ReturnType<typeof getRedis>>) {
  const appendixRaw = await redis.get(APPENDIX_KEY);
  if (!appendixRaw) {
    return { ok: false, error: "no pm:appendix-daily-values found" } as const;
  }
  const appendix = JSON.parse(appendixRaw) as AppendixData;
  if (!appendix.ledgers || appendix.ledgers.length === 0) {
    return { ok: false, error: "appendix has no ledgers" } as const;
  }

  const perfRaw = await redis.get(PERF_KEY);
  const existingPerf: PimPerformanceData = perfRaw
    ? (JSON.parse(perfRaw) as PimPerformanceData)
    : { models: [], lastUpdated: new Date().toISOString() };

  // Stash current blob
  if (perfRaw) {
    await redis.set(`${PERF_KEY}.pre-restore-${Date.now()}`, perfRaw);
  }

  // Preserve every non-PIM series as-is
  const otherGroupModels = existingPerf.models.filter((m) => m.groupId !== "pim");

  const rebuiltPimModels: PimModelPerformance[] = [];
  for (const ledger of appendix.ledgers as AppendixModelLedger[]) {
    const profile = ledger.profile as PimProfileType;
    const providerLastDate = ledger.entries[ledger.entries.length - 1]?.date || "";
    // Preserve any post-provider entries from the existing PIM series
    const existingModel = existingPerf.models.find(
      (m) => m.groupId === "pim" && m.profile === profile
    );
    const postProviderEntries = existingModel?.history.filter(
      (h) => h.date > providerLastDate
    ) || [];

    const history = [
      ...ledger.entries.map((e) => ({ date: e.date, value: e.value, dailyReturn: e.dailyReturn })),
      ...postProviderEntries,
    ];

    rebuiltPimModels.push({
      groupId: "pim",
      profile,
      history,
      lastUpdated: new Date().toISOString(),
    });
  }

  const restored: PimPerformanceData = {
    models: [...otherGroupModels, ...rebuiltPimModels],
    lastUpdated: new Date().toISOString(),
  };

  await redis.set(PERF_KEY, JSON.stringify(restored));

  return {
    ok: true,
    profilesRestored: rebuiltPimModels.map((m) => m.profile),
    pimModelCount: rebuiltPimModels.length,
    nonPimModelCount: otherGroupModels.length,
  } as const;
}

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
    const backupSummary: Array<{ date: string; hasPerf: boolean; modelCount?: number; perfLastUpdated?: string }> = [];
    for (const date of dates.slice(0, 10)) {
      const raw = await redis.get(`${BACKUP_PREFIX}${date}`);
      if (!raw) { backupSummary.push({ date, hasPerf: false }); continue; }
      const blob = JSON.parse(raw) as BackupBlob;
      const perfRaw = blob.data?.[PERF_KEY];
      if (!perfRaw) { backupSummary.push({ date, hasPerf: false }); continue; }
      try {
        const perf = JSON.parse(perfRaw) as { models?: unknown[]; lastUpdated?: string };
        backupSummary.push({
          date,
          hasPerf: true,
          modelCount: Array.isArray(perf.models) ? perf.models.length : undefined,
          perfLastUpdated: perf.lastUpdated,
        });
      } catch {
        backupSummary.push({ date, hasPerf: false });
      }
    }

    // Side-by-side diagnostic: compare what the live perf blob says
    // for PIM/Balanced vs what the immutable appendix says. If both
    // show ~250% ITD, the appendix itself is the culprit and an
    // appendix-based restore can't help. If they diverge, the live
    // blob is the corrupted one and the restore should fix it.
    const perfRaw = await redis.get(PERF_KEY);
    const appendixRaw = await redis.get(APPENDIX_KEY);
    const perf = perfRaw ? (JSON.parse(perfRaw) as PimPerformanceData) : null;
    const appendix = appendixRaw ? (JSON.parse(appendixRaw) as AppendixData) : null;

    const summarize = (firstVal: number | undefined, lastVal: number | undefined, count: number, firstDate?: string, lastDate?: string) => {
      if (firstVal == null || lastVal == null || firstVal <= 0) return null;
      const periodReturn = lastVal / firstVal - 1;
      return { count, firstDate, firstValue: firstVal, lastDate, lastValue: lastVal, periodReturn: `${(periodReturn * 100).toFixed(2)}%` };
    };

    // Chain the dailyReturn fields independently to test the user's
    // hypothesis: if the stored cumulative VALUE is corrupted but the
    // per-entry dailyReturn is intact, chaining should give a different
    // (correct) cumulative. If chained ≈ stored, the dailyReturns are
    // themselves biased and re-chaining can't help.
    const chainDailyReturns = (entries: Array<{ value: number; dailyReturn: number; date: string }> | undefined) => {
      if (!entries || entries.length === 0) return null;
      let cumulative = 100;
      for (let i = 1; i < entries.length; i++) {
        cumulative *= 1 + entries[i].dailyReturn / 100;
      }
      const periodReturn = cumulative / 100 - 1;
      return { chainedFinalValue: parseFloat(cumulative.toFixed(4)), periodReturn: `${(periodReturn * 100).toFixed(2)}%` };
    };

    const profiles = ["balanced", "growth", "allEquity", "alpha"] as const;
    const compare: Record<string, {
      perfBlob: ReturnType<typeof summarize>;
      appendix: ReturnType<typeof summarize>;
      appendixChainedFromDailyReturns: ReturnType<typeof chainDailyReturns>;
    }> = {};
    for (const p of profiles) {
      const perfModel = perf?.models.find((m) => m.groupId === "pim" && m.profile === p);
      const ledger = appendix?.ledgers.find((l) => l.profile === p);
      compare[p] = {
        perfBlob: perfModel ? summarize(
          perfModel.history[0]?.value, perfModel.history[perfModel.history.length - 1]?.value,
          perfModel.history.length, perfModel.history[0]?.date, perfModel.history[perfModel.history.length - 1]?.date,
        ) : null,
        appendix: ledger ? summarize(
          ledger.entries[0]?.value, ledger.entries[ledger.entries.length - 1]?.value,
          ledger.entries.length, ledger.entries[0]?.date, ledger.entries[ledger.entries.length - 1]?.date,
        ) : null,
        appendixChainedFromDailyReturns: chainDailyReturns(ledger?.entries),
      };
    }

    return NextResponse.json({
      backups: backupSummary,
      pimGroupComparison: compare,
      hint: "If perfBlob and appendix periodReturn agree, the appendix is also corrupted and appendix-restore can't help. If they diverge, run POST with { source: 'appendix' } to restore.",
    });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const source = typeof body?.source === "string" ? body.source : "";
    const redis = await getRedis();

    // Source: "appendix" → rebuild PIM series from pm:appendix-daily-values.
    // Default / "backup" → restore from a pm:backup:<date> snapshot.
    if (source === "appendix") {
      const result = await restoreFromAppendix(redis);
      const status = result.ok ? 200 : 404;
      return NextResponse.json(result, { status });
    }

    const requestedDate = typeof body?.date === "string" ? body.date.trim() : "";

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
