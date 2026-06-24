import { NextResponse } from "next/server";
import { listBackupBlobs } from "@/app/lib/backup-store";

/**
 * Read-only backup-health probe. Returns the age of the most recent backup
 * (now stored in Vercel Blob) + a status the nav indicator colors on:
 *
 *   - "ok"        newest backup < 30h old (the daily 06:00 UTC cron ran)
 *   - "warning"   30–50h (one cycle likely missed)
 *   - "critical"  > 50h, OR no backups at all (the silent-failure state
 *                 that went unnoticed for 17 days)
 *
 * Reads Blob metadata only (no content download, no writes). The nav polls
 * this so a stalled backup cron becomes impossible to miss.
 */

const OK_HOURS = 30;
const WARN_HOURS = 50;

export async function GET() {
  try {
    const backups = await listBackupBlobs(); // newest first
    if (backups.length === 0) {
      return NextResponse.json({
        ok: true,
        status: "critical",
        backupCount: 0,
        lastBackupAt: null,
        ageHours: null,
        message: "No backups exist.",
      });
    }

    const newest = backups[0];
    const newestMs = Date.parse(newest.uploadedAt);
    const newestKey = newest.pathname;
    const ageHours = (Date.now() - newestMs) / 3_600_000;
    const status = ageHours <= OK_HOURS ? "ok" : ageHours <= WARN_HOURS ? "warning" : "critical";

    return NextResponse.json({
      ok: true,
      status,
      backupCount: backups.length,
      lastBackupAt: new Date(newestMs).toISOString(),
      lastBackupKey: newestKey,
      ageHours: Math.round(ageHours * 10) / 10,
    });
  } catch (e) {
    // Distinct shape so the nav can tell "couldn't check" from "stale".
    return NextResponse.json(
      { ok: false, status: "unknown", error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
