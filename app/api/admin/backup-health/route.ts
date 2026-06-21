import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Read-only backup-health probe. Returns the age of the most recent
 * pm:backup:* snapshot + a status the nav indicator colors on:
 *
 *   - "ok"        newest backup < 30h old (the daily 06:00 UTC cron ran)
 *   - "warning"   30–50h (one cycle likely missed)
 *   - "critical"  > 50h, OR no backups at all (the silent-failure state
 *                 that went unnoticed for 17 days)
 *
 * No writes, so it works even when the instance is OOM. The nav polls this
 * so a stalled backup cron becomes impossible to miss instead of being
 * discovered by accident.
 */

const BACKUP_PREFIX = "pm:backup:";
const OK_HOURS = 30;
const WARN_HOURS = 50;

export async function GET() {
  try {
    const redis = await getRedis();
    const keys: string[] = [];
    for await (const key of redis.scanIterator({ MATCH: `${BACKUP_PREFIX}*`, COUNT: 200 })) {
      if (Array.isArray(key)) keys.push(...key);
      else keys.push(key);
    }

    if (keys.length === 0) {
      return NextResponse.json({
        ok: true,
        status: "critical",
        backupCount: 0,
        lastBackupAt: null,
        ageHours: null,
        message: "No backups exist.",
      });
    }

    // Newest by the ISO timestamp embedded after the prefix.
    let newestMs = -Infinity;
    let newestKey = "";
    for (const k of keys) {
      const t = Date.parse(k.slice(BACKUP_PREFIX.length));
      if (Number.isFinite(t) && t > newestMs) { newestMs = t; newestKey = k; }
    }

    if (!Number.isFinite(newestMs)) {
      return NextResponse.json({
        ok: true,
        status: "critical",
        backupCount: keys.length,
        lastBackupAt: null,
        ageHours: null,
        message: "Backups exist but none have a parseable timestamp.",
      });
    }

    const ageHours = (Date.now() - newestMs) / 3_600_000;
    const status = ageHours <= OK_HOURS ? "ok" : ageHours <= WARN_HOURS ? "warning" : "critical";

    return NextResponse.json({
      ok: true,
      status,
      backupCount: keys.length,
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
