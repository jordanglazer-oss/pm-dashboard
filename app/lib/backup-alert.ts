import { enqueueMail } from "./mail-outbox";
import { listBackupBlobs } from "./backup-store";
import { createLogger } from "./logger";

/**
 * Tell the PM by email when the nightly backup fails or goes stale.
 *
 * Before this, a failed backup run returned a 500 that nobody saw and also
 * skipped that night's digest email; the only sign was the nav chip. Both
 * helpers are best-effort and never throw. They touch one Redis key,
 * pm:mail-outbox, through enqueueMail (read-merge-write, idempotent by id —
 * at most one mail of each kind per day).
 */

const log = createLogger("BackupAlert");
const STALE_HOURS = 30; // same "ok" line as /api/admin/backup-health

function recipients(): string {
  return (process.env.ALERT_EMAIL_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
}

/** Called by the backup cron when the run fails. */
export async function emailBackupFailure(reason: string, backupWritten: boolean): Promise<boolean> {
  try {
    const to = recipients();
    if (!to) return false;
    const day = new Date().toISOString().slice(0, 10);
    const headline = backupWritten
      ? "Last night's backup was saved, but a later step of the nightly job failed."
      : "Last night's backup was NOT saved.";
    return await enqueueMail({
      id: `backup-failed-${day}`,
      to,
      subject: backupWritten ? `Dashboard nightly job failed — ${day}` : `Dashboard backup FAILED — ${day}`,
      text: [
        headline,
        "",
        `Reason: ${reason}`,
        "",
        backupWritten
          ? "The morning digest email may be missing today."
          : "Until this is fixed there is no fresh copy of the data outside the live database. Avoid large changes (rebalances, staged applies) until a backup succeeds.",
        "",
        "Check: https://pm-dashboard-7rr9.vercel.app/admin/health",
      ].join("\n"),
      queuedAt: new Date().toISOString(),
    });
  } catch (e) {
    log.error("could not queue the failure email:", e);
    return false;
  }
}

/**
 * Independent check, run from a DIFFERENT cron than the backup itself, so a
 * backup job that never starts (misconfigured schedule, rejected secret) is
 * still noticed. Emails when the newest backup is older than 30 hours.
 */
export async function emailIfBackupStale(): Promise<{ checked: boolean; stale: boolean; ageHours: number | null }> {
  try {
    const backups = await listBackupBlobs(); // newest first
    const newest = backups[0];
    const ageHours = newest ? (Date.now() - Date.parse(newest.uploadedAt)) / 3_600_000 : null;
    const stale = ageHours === null || ageHours > STALE_HOURS;
    if (stale) {
      const to = recipients();
      if (to) {
        const day = new Date().toISOString().slice(0, 10);
        await enqueueMail({
          id: `backup-stale-${day}`,
          to,
          subject: `Dashboard backup is overdue — ${day}`,
          text: [
            ageHours === null
              ? "No backup exists."
              : `The newest backup is ${Math.round(ageHours)} hours old. One is expected every night.`,
            "",
            "The nightly backup job has not run or has not finished. Avoid large changes (rebalances, staged applies) until a backup succeeds.",
            "",
            "Check: https://pm-dashboard-7rr9.vercel.app/admin/health",
          ].join("\n"),
          queuedAt: new Date().toISOString(),
        });
      }
    }
    return { checked: true, stale, ageHours: ageHours === null ? null : Math.round(ageHours * 10) / 10 };
  } catch (e) {
    log.error("stale-backup check failed:", e);
    return { checked: false, stale: false, ageHours: null };
  }
}
