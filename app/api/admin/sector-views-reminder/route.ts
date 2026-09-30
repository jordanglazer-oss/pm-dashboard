import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { maybeQueueSectorViewsReminder, REMINDER_DAY } from "@/app/lib/sector-views";

/**
 * Test / resend the monthly Fundstrat sector-table reminder.
 *
 *   GET                  → dry run: status only (last scheduled month, the
 *                          stored table date). Writes nothing.
 *   GET ?confirm=YES     → queue the reminder NOW via the inbox Gmail outbox.
 *                          Doesn't consume the scheduled reminder on the 3rd.
 *
 * Only writes pm:mail-outbox (one message). Behind the auth-cookie middleware.
 */
export async function GET(req: NextRequest) {
  const redis = await getRedis();
  const reminderRaw = await redis.get("pm:sector-views-reminder");
  const researchRaw = await redis.get("pm:research");
  const research = researchRaw ? (JSON.parse(researchRaw) as { sectorViewsMonthlyAt?: string; sectorViewLog?: unknown[] }) : {};
  const status = {
    reminderDay: REMINDER_DAY,
    lastScheduled: reminderRaw ? JSON.parse(reminderRaw) : null,
    tableIngestedAt: research.sectorViewsMonthlyAt ?? null,
    recentChanges: (research.sectorViewLog ?? []).slice(0, 10),
  };
  if (req.nextUrl.searchParams.get("confirm") !== "YES") {
    return NextResponse.json({ dryRun: true, hint: "Add ?confirm=YES to send the reminder now.", ...status });
  }
  const r = await maybeQueueSectorViewsReminder({ force: true });
  return NextResponse.json({ dryRun: false, ...r, ...status });
}
