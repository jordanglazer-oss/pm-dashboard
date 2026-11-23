import { NextRequest, NextResponse } from "next/server";
import { runStanceWatch } from "@/app/lib/agents/stance-watch";
import { runManagerWatch } from "@/app/lib/agents/manager-watch";
import { runWatchlistAlerts } from "@/app/lib/agents/watchlist-alerts";
import { listFlags } from "@/app/lib/agents/flags";
import { runPortfolioAudit } from "@/app/lib/agents/portfolio-audit";
import { runDevilsAdvocateIfDue } from "@/app/lib/agents/devils-advocate";
import { sendAuditEmail } from "@/app/lib/agents/flag-mail";

/**
 * GET /api/cron/stance-watch — weekday after-close stance watch + hedge
 * window (22:00 UTC = 17:00 EST / 18:00 EDT, see vercel.json). CRON_SECRET
 * bearer; /api/cron/* is exempt from the cookie middleware.
 * Also runs the quarterly manager watch when this quarter has not been
 * reviewed yet (returns at once otherwise).
 * Then the rule-based portfolio audit (app/lib/agents/portfolio-audit.ts,
 * no model call; raises flags, writes pm:agent-state:portfolio-audit).
 * Last step: the end-of-day audit email (app/lib/agents/flag-mail.ts) —
 * always queued on a weekday, even with nothing new; never fails the cron.
 * Redis: writes only pm:agent-state:stance / :manager-watch /
 * :audit-email, pm:mail-outbox and, on a change, pm:agent-flag:*.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return NextResponse.json({ error: "CRON_SECRET env var not configured" }, { status: 500 });
  if (req.headers.get("authorization") !== `Bearer ${cronSecret}`) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  try {
    const out = await runStanceWatch();
    console.log(`[cron/stance-watch] ${out.skipped ?? out.error ?? `${out.state?.changes?.length ?? 0} changes, hedge window ${out.state?.hedgeWindow.window}`}`);
    let manager: unknown = null;
    try {
      const m = await runManagerWatch();
      manager = { ok: m.ok, skipped: m.skipped, error: m.error, reviewed: m.state?.reviews?.length };
    } catch (e) {
      manager = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    // Watchlist rules ($0, never throws): target buy price reached / newly on 2+ lists.
    const watchlist = await runWatchlistAlerts();
    console.log(`[cron/stance-watch] watchlist alerts: ${watchlist.skipped ?? watchlist.error ?? `${watchlist.alerts.length} found, ${watchlist.raised.length} new`}`);
    // Rule audits ($0) run before the email so tonight's email carries them.
    const audit = await runPortfolioAudit();
    console.log(`[cron/stance-watch] portfolio audit: ${audit.skipped ?? audit.error ?? `${audit.findings.length} findings, ${audit.raised.length} new`}`);
    // Monthly devil's advocate: a batch each evening from the Wednesday before the first Monday (never throws).
    const advocate = await runDevilsAdvocateIfDue();
    console.log(`[cron/stance-watch] devil's advocate: ${"written" in advocate ? `${advocate.written.length} written, ${advocate.pending.length} pending` : advocate.skipped}`);
    const mail = await sendAuditEmail(await listFlags());
    console.log(`[cron/stance-watch] audit email: ${mail.queued ? "queued" : mail.reason ?? "not queued"}`);
    return NextResponse.json({ ...out, manager, portfolioAudit: { ok: audit.ok, skipped: audit.skipped, error: audit.error, findings: audit.findings.length, raised: audit.raised.length }, auditEmail: { ok: mail.ok, queued: mail.queued, reason: mail.reason, newCount: mail.email?.newCount } });
  } catch (e) {
    console.error("[cron/stance-watch] failed:", e);
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
