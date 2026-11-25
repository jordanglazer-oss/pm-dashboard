import { NextRequest, NextResponse } from "next/server";
import { refreshDailyValues } from "@/app/lib/daily-value-refresh";
import { emailIfBackupStale } from "@/app/lib/backup-alert";
import { updateFundNavLog } from "@/app/lib/fund-nav-log";

/**
 * GET /api/cron/daily-value — weekday after-close (21:30 UTC = 17:30 ET,
 * see vercel.json) recalculation of the PIM performance ledger, so the
 * settled session lands in pm:pim-performance even when nobody opened the
 * app. Same CRON_SECRET header auth as the other crons; /api/cron/* is
 * exempt from the cookie middleware for Vercel's runner.
 *
 * Redis: writes only what /api/update-daily-value already writes
 * (pm:pim-performance, pm:appendix-daily-values), via that route's own
 * read-modify-write, plus the append-only pm:fund-nav-log (write-aside). Best-effort — a Yahoo hiccup returns 200 with `error`.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  }
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const startedAt = new Date().toISOString();
  const result = await refreshDailyValues();
  console.log(`[cron/daily-value] ${result.error ? `failed: ${result.error}` : `${result.message ?? "ok"} (${result.updates ?? 0} models)`}`);
  // (Nov 2026: the separate weights-only sleeve tracker, pm:sleeve-performance,
  // is no longer updated — the Core / Thematic / Alpha books in the ledger
  // above are the single source of sleeve performance.)
  // Independent of the backup cron on purpose: if that job never starts, this
  // one still notices the newest backup is overdue and emails. Best-effort.
  const backupCheck = await emailIfBackupStale();
  // Our own record of each mutual fund's NAV and distributions (pm:fund-nav-log).
  // Write-aside: it only ADDS entries, never throws, and nothing above depends on it.
  const fundLog = await updateFundNavLog();
  console.log(`[cron/daily-value] fund log: ${fundLog.error ? `failed: ${fundLog.error}` : fundLog.funds.map((f) => `${f.code} +${f.navAdded}${f.distributionsAdded.length ? ` (+${f.distributionsAdded.length} distribution)` : ""}`).join(", ") || "no funds"}`);
  return NextResponse.json({ ok: !result.error, startedAt, finishedAt: new Date().toISOString(), ...result, backupCheck, fundLog });
}
