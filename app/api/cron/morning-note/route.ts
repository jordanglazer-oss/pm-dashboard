import { NextRequest, NextResponse } from "next/server";
import { generateMorningNote } from "@/app/lib/morning-note";
import { easternDay, isWeekday } from "@/app/lib/morning-note-shared";

/**
 * GET /api/cron/morning-note — writes the weekday Morning note before the
 * open. Schedule it at 11:15 UTC on weekdays (6:15 am ET in winter, 7:15 am
 * ET in summer — always ready before 8:00 ET). CRON_SECRET bearer;
 * /api/cron/* is exempt from the cookie middleware.
 *
 * Skips weekends, and returns the note already on file when today's has been
 * written (a re-run of the cron never spends twice). Redis: writes only
 * pm:morning-note:<today> (see app/lib/morning-note.ts).
 */

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const today = easternDay();
  if (!isWeekday(today)) return NextResponse.json({ ok: true, skipped: "weekend" });
  try {
    const res = await generateMorningNote({ ifMissing: true });
    console.log(`[cron/morning-note] ${res.skipped ?? res.error ?? `written, est $${res.note?.usage?.estUsd ?? 0}`}`);
    return NextResponse.json({ ok: res.ok, skipped: res.skipped, error: res.error, date: today, usage: res.note?.usage }, { status: res.ok ? 200 : 500 });
  } catch (e) {
    console.error("[cron/morning-note] failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
