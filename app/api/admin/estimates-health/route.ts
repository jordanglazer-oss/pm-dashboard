import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { ESTIMATES_STATUS_KEY, type EstimatesRefreshStatus } from "@/app/lib/estimates-refresh";

/**
 * Read-only freshness probe for the daily FactSet estimates refresh. Mirrors
 * /api/admin/backup-health: returns the age of the last successful run + a
 * status the nav chip colors on. Reads one small marker key, no writes.
 *
 *   - "ok"        last run < 30h ago (the daily cron ran)
 *   - "warning"   30-50h (one cycle likely missed)
 *   - "critical"  > 50h, or never run, or the last run errored
 */
const OK_HOURS = 30;
const WARN_HOURS = 50;

export async function GET() {
  try {
    const redis = await getRedis();
    const raw = await redis.get(ESTIMATES_STATUS_KEY);
    if (!raw) {
      return NextResponse.json({ ok: true, status: "critical", lastRunAt: null, ageHours: null, message: "never run" });
    }
    const s = JSON.parse(raw) as EstimatesRefreshStatus;
    const ms = Date.parse(s.lastRunAt);
    const ageHours = Number.isFinite(ms) ? (Date.now() - ms) / 3_600_000 : null;
    let status: "ok" | "warning" | "critical";
    if (s.error) status = "critical";
    else if (ageHours == null) status = "critical";
    else status = ageHours <= OK_HOURS ? "ok" : ageHours <= WARN_HOURS ? "warning" : "critical";
    return NextResponse.json({
      ok: true,
      status,
      lastRunAt: s.lastRunAt,
      ageHours: ageHours == null ? null : Math.round(ageHours * 10) / 10,
      tickerCount: s.tickerCount,
      resolvedCount: s.resolvedCount,
      updatedCount: s.updatedCount,
      error: s.error,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, status: "unknown", error: e instanceof Error ? e.message : String(e) },
      { status: 200 },
    );
  }
}
