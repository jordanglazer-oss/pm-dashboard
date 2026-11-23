import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { listBackupBlobs, readBackupBlob, type BackupInfo } from "@/app/lib/backup-store";
import type { AnalystReports, AnalystSnapshots } from "@/app/lib/analyst-snapshots";
import {
  REPORT_HISTORY_PREFIX,
  REPORT_SOURCES,
  isReportMeta,
  mergeReports,
  parseTickerHistory,
  reportHistoryKey,
  type ReportToRecord,
  type TickerReportHistory,
} from "@/app/lib/analyst-report-history";

/**
 * GET /api/admin/backfill-analyst-report-history[?scan=1][&confirm=YES][&days=30][&step=3]
 *
 * One-off start of pm:analyst-report-history:<TICKER>: records every report
 * in the LIVE pm:analyst-reports, plus older reports recovered from the
 * nightly Blob backups (each backup holds that day's manifest, so a report
 * that was replaced within the backup window can be recovered).
 *
 *   (no params)        PLAN only — lists the backups it would read and their
 *                      size. Reads no backup.
 *   ?scan=1            Reads the backups, reports what would be added. Writes
 *                      nothing.
 *   ?scan=1&confirm=YES  Writes. ONLY ADDS entries (duplicates skipped by PDF
 *                      hash / identical facts); stashes any existing history
 *                      keys at pm:analyst-report-history.pre-backfill-<ts>
 *                      first. Never touches pm:analyst-reports or
 *                      pm:analyst-snapshots (read-only here).
 *
 * `step` (days, default 3) spaces the backups read so a 30-day window costs
 * ~10 Blob reads, not 30 — reports change far less often than nightly.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const log = createLogger("Backfill-report-history");

type Candidates = Map<string, ReportToRecord[]>;

function collect(into: Candidates, reports: AnalystReports | null, snaps: AnalystSnapshots | null) {
  if (!reports || typeof reports !== "object") return;
  for (const [ticker, byBank] of Object.entries(reports)) {
    if (!byBank || typeof byBank !== "object") continue;
    for (const source of REPORT_SOURCES) {
      const meta = (byBank as Record<string, unknown>)[source];
      if (!isReportMeta(meta)) continue;
      let price: number | undefined;
      if (source !== "morningstar") {
        const e = snaps?.[ticker]?.[source];
        if (e && e.asOf && e.asOf === meta.extracted.asOf && typeof e.priceAtReport === "number") price = e.priceAtReport;
      }
      const list = into.get(ticker) ?? [];
      if (!list.some((r) => r.source === source && r.meta.hash === meta.hash)) list.push({ source, meta, priceAtReport: price });
      into.set(ticker, list);
    }
  }
}

function parse<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Newest first, at least `step` days apart, within `days`. */
function pickBackups(all: BackupInfo[], days: number, step: number): BackupInfo[] {
  const cutoff = Date.now() - days * 86400000;
  const out: BackupInfo[] = [];
  for (const b of all) {
    const t = Date.parse(b.uploadedAt);
    if (!Number.isFinite(t) || t < cutoff) continue;
    const last = out[out.length - 1];
    if (last && Date.parse(last.uploadedAt) - t < step * 86400000 - 3600000) continue;
    out.push(b);
  }
  return out;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const scan = sp.get("scan") === "1";
  const confirm = sp.get("confirm") === "YES";
  const days = Math.min(60, Math.max(1, Number(sp.get("days")) || 30));
  const step = Math.min(30, Math.max(1, Number(sp.get("step")) || 3));

  try {
    const redis = await getRedis();
    const [repRaw, snapRaw] = await Promise.all([redis.get("pm:analyst-reports"), redis.get("pm:analyst-snapshots")]);
    const liveReports = parse<AnalystReports>(repRaw);
    if (repRaw && !liveReports) return NextResponse.json({ error: "pm:analyst-reports is unreadable — nothing done" }, { status: 500 });
    const backups = pickBackups(await listBackupBlobs(), days, step);
    const liveCount = Object.values(liveReports ?? {}).reduce(
      (n, b) => n + REPORT_SOURCES.filter((s) => isReportMeta((b as Record<string, unknown>)?.[s])).length,
      0,
    );

    if (!scan) {
      return NextResponse.json({
        mode: "plan",
        liveReports: liveCount,
        backupsToRead: backups.map((b) => ({ pathname: b.pathname, mb: Math.round((b.sizeBytes / 1048576) * 10) / 10 })),
        totalMb: Math.round((backups.reduce((n, b) => n + b.sizeBytes, 0) / 1048576) * 10) / 10,
        next: "Add &scan=1 to read them (writes nothing), then &scan=1&confirm=YES to write.",
      });
    }

    const candidates: Candidates = new Map();
    collect(candidates, liveReports, parse<AnalystSnapshots>(snapRaw));
    const read: string[] = [];
    const failed: string[] = [];
    for (const b of backups) {
      try {
        const snap = await readBackupBlob(b.pathname);
        collect(candidates, parse<AnalystReports>(snap.data?.["pm:analyst-reports"]), parse<AnalystSnapshots>(snap.data?.["pm:analyst-snapshots"]));
        read.push(b.pathname);
      } catch (e) {
        log.warn("backup read failed:", b.pathname, e);
        failed.push(b.pathname);
      }
    }

    const nowIso = new Date().toISOString();
    const plan: { ticker: string; key: string; before: TickerReportHistory; after: TickerReportHistory; added: number }[] = [];
    const unreadable: string[] = [];
    for (const [ticker, list] of candidates) {
      const key = reportHistoryKey(ticker);
      const before = parseTickerHistory(await redis.get(key));
      if (before === null) {
        unreadable.push(key);
        continue;
      }
      const { history, added } = mergeReports(before, list, nowIso);
      if (added > 0) plan.push({ ticker, key, before, after: history, added });
    }

    const summary = plan
      .map((p) => ({
        ticker: p.ticker,
        added: p.added,
        reports: REPORT_SOURCES.flatMap((s) =>
          (p.after[s] ?? []).map((e) => `${s} ${e.asOf ?? "?"} ${e.rating ?? (e.stars != null ? e.stars + "★" : "")} ${e.target ?? e.fairValue ?? ""}`.trim()),
        ),
      }))
      .sort((a, b) => a.ticker.localeCompare(b.ticker));
    const totalAdded = plan.reduce((n, p) => n + p.added, 0);

    if (!confirm) {
      return NextResponse.json({ mode: "scan (nothing written)", backupsRead: read, backupsFailed: failed, unreadable, tickers: plan.length, entriesToAdd: totalAdded, summary, next: "Add &confirm=YES to write." });
    }

    // Stash every existing history key before writing.
    const existing: Record<string, string> = {};
    for await (const k of redis.scanIterator({ MATCH: `${REPORT_HISTORY_PREFIX}*`, COUNT: 200 })) {
      for (const key of Array.isArray(k) ? k : [k]) {
        const v = await redis.get(key);
        if (v) existing[key] = v;
      }
    }
    let stashKey: string | null = null;
    if (Object.keys(existing).length) {
      stashKey = `pm:analyst-report-history.pre-backfill-${Date.now()}`;
      await redis.set(stashKey, JSON.stringify(existing));
    }
    // Re-read + re-merge each key right before writing, so a report ingested
    // while this ran is kept.
    for (const p of plan) {
      const now = parseTickerHistory(await redis.get(p.key));
      if (now === null) continue;
      const { history } = mergeReports(now, candidates.get(p.ticker) ?? [], nowIso);
      await redis.set(p.key, JSON.stringify(history));
    }
    log.info("wrote", totalAdded, "entries across", plan.length, "tickers");
    return NextResponse.json({ mode: "written", stashKey, backupsRead: read, backupsFailed: failed, unreadable, tickers: plan.length, entriesAdded: totalAdded, summary });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
