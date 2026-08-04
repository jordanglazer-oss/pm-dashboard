import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { readPendingMail } from "@/app/lib/mail-outbox";
import { isTradingWeekdayET } from "@/app/lib/market-calendar";

/**
 * GET /api/admin/digest-status — why did (or didn't) the overnight email go?
 *
 * The digest has FIVE independent reasons it can stay silent, and none of them
 * was visible from the outside: no HIGH alerts, ALERT_EMAIL_TO unset, the
 * weekend rule, the cron not running, or mail queued but never drained by the
 * Apps Script. Diagnosing meant guessing. This reports each one.
 *
 * Read-only; never sends. Secrets are reported as booleans, never values.
 */

export const dynamic = "force-dynamic";

type LoggedDigest = { generatedAt: string; counts?: { high?: number; medium?: number; total?: number } };

export async function GET() {
  try {
    const redis = await getRedis();
    const [logRaw, pending] = await Promise.all([
      redis.get("pm:alert-log").catch(() => null),
      readPendingMail().catch(() => []),
    ]);

    let log: Record<string, LoggedDigest> = {};
    try {
      if (logRaw) log = JSON.parse(logRaw) as Record<string, LoggedDigest>;
    } catch {
      /* report an empty log rather than failing the diagnostic */
    }
    const dates = Object.keys(log).sort().slice(-5).reverse();
    const recent = dates.map((d) => ({
      date: d,
      generatedAt: log[d]?.generatedAt ?? null,
      high: log[d]?.counts?.high ?? 0,
      medium: log[d]?.counts?.medium ?? 0,
    }));

    const today = new Date().toISOString().slice(0, 10);
    const latest = recent[0];
    const alertToConfigured = Boolean((process.env.ALERT_EMAIL_TO || "").trim());

    // Walk the same gates runAlertDigest applies, in order.
    const diagnosis: string[] = [];
    if (!latest) diagnosis.push("No alert-log entry at all — the nightly cron has not completed a digest.");
    else if (latest.date !== today)
      diagnosis.push(`Newest alert-log entry is ${latest.date}, not today (${today}) — the cron did not run or failed before the digest step.`);
    if (!isTradingWeekdayET()) diagnosis.push("Today is a weekend in ET — the email is suppressed by design (the log is still written).");
    if (!alertToConfigured) diagnosis.push("ALERT_EMAIL_TO is NOT set — the digest computes but is never queued.");
    if (latest && latest.high === 0)
      diagnosis.push("Zero HIGH-priority alerts — the digest only emails on a HIGH alert, a data-health problem, or an overnight rescore.");
    if (pending.length > 0)
      diagnosis.push(
        `${pending.length} message(s) SITTING IN THE OUTBOX — they were queued but the Apps Script processOutbox has not drained them. Check that its 5-minute trigger exists.`,
      );
    if (diagnosis.length === 0) diagnosis.push("All gates passed — a digest should have been queued and drained.");

    return NextResponse.json({
      today,
      weekendSuppressed: !isTradingWeekdayET(),
      alertToConfigured,
      pendingOutbox: pending.map((m) => ({ id: m.id, subject: m.subject, queuedAt: m.queuedAt })),
      recentDigests: recent,
      diagnosis,
    });
  } catch (e) {
    console.error("digest-status failed:", e);
    return NextResponse.json({ error: "diagnostic failed" }, { status: 500 });
  }
}
