import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts, type Alert } from "@/app/lib/alerts";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { enqueueMail } from "@/app/lib/mail-outbox";
import type { DataHealthReport } from "@/app/lib/data-health";

/**
 * Daily alert digest (Phase 07) — the "when you're not looking" half. Run from
 * the daily cron AFTER its inputs are refreshed (FactSet estimates → market
 * regime → thesis health), so the email never goes out on a prior day's data.
 *
 * Computes today's alerts from the SAME loadAlertInputs() the in-app tile uses
 * (so the email and the tile always agree), appends a snapshot to the
 * append-only pm:alert-log (one per date, never overwritten, 60-day retention),
 * and queues the email to the Gmail outbox IF a recipient is configured AND
 * there are high-priority alerts. Best-effort; never throws.
 */

const log = createLogger("AlertDigest");
const LOG_KEY = "pm:alert-log";

type LoggedDigest = { generatedAt: string; counts: ReturnType<typeof alertCounts>; alerts: Alert[] };

const CAT_LABEL: Record<string, string> = { thesis: "THESIS", regime: "REGIME", technical: "TECHNICAL" };

/**
 * Plain-text digest — the Gmail outbox sends text bodies via GmailApp.sendEmail.
 * Each alert gets its headline, the specific signals that drove it, the
 * supporting numbers, and the concrete next step — so the email stands on its
 * own without opening the dashboard.
 */
type RecentRescore = { at: string; ticker: string; trigger: string; mode: "full" | "partial"; before: number | null; after: number | null };

function renderDigestText(
  alerts: Alert[],
  counts: ReturnType<typeof alertCounts>,
  date: string,
  dataHealth?: DataHealthReport,
  rescores: RecentRescore[] = []
): string {
  const lines: string[] = [
    `NEEDS YOUR ATTENTION — ${date}`,
    `${counts.high} high · ${counts.medium} to watch`,
    "",
  ];

  const section = (label: string, rows: Alert[]) => {
    if (!rows.length) return;
    lines.push(`${label}`, "─".repeat(52));
    for (const a of rows) {
      const who = a.name && a.ticker ? `${a.title} — ${a.name}` : a.title;
      lines.push(`[${CAT_LABEL[a.category] ?? a.category.toUpperCase()}] ${who}`);
      if (a.detail) lines.push(`  Why: ${a.detail}`);
      for (const m of a.metrics ?? []) lines.push(`  · ${m}`);
      if (a.action) lines.push(`  → ${a.action}`);
      lines.push("");
    }
  };

  section("HIGH PRIORITY", alerts.filter((a) => a.priority === "high"));
  section("TO WATCH", alerts.filter((a) => a.priority === "medium"));

  // Overnight auto-rescores — every score the event engine moved since the
  // last digest, with the trigger, so a changed ranking is never a mystery.
  if (rescores.length > 0) {
    lines.push("OVERNIGHT RESCORES", "─".repeat(52));
    for (const r of rescores) {
      const delta =
        r.before != null && r.after != null
          ? ` ${r.before.toFixed(1)} → ${r.after.toFixed(1)}`
          : "";
      lines.push(`  ${r.ticker} (${r.mode}):${delta} — ${r.trigger}`);
    }
    lines.push("");
  }

  // Data health — one line when everything is fresh, problems-first when not.
  // This is what makes the numbers above trustworthy without checking them.
  if (dataHealth) {
    lines.push("DATA HEALTH", "─".repeat(52));
    for (const l of dataHealth.lines) lines.push(`  ${l}`);
    lines.push("");
  }

  lines.push("─".repeat(52));
  lines.push("Full detail (and the Opportunities half) in the dashboard:");
  lines.push("https://pm-dashboard-7rr9.vercel.app/");
  return lines.join("\n");
}

export async function runAlertDigest(opts?: {
  dataHealth?: DataHealthReport;
}): Promise<{ ran: boolean; total: number; emailed: boolean; error?: string }> {
  try {
    const redis = await getRedis();
    const { thesis, transition, risk, context } = await loadAlertInputs();

    const alerts = computeAlerts({ thesis, transition, risk, context });
    const counts = alertCounts(alerts);
    const today = new Date().toISOString().slice(0, 10);

    // Append-only log — never overwrite an existing date; 60-day retention.
    let store: Record<string, LoggedDigest> = {};
    try {
      const raw = await redis.get(LOG_KEY);
      if (raw) store = JSON.parse(raw) as Record<string, LoggedDigest>;
    } catch {
      /* start fresh on parse error */
    }
    if (!store[today]) {
      store[today] = { generatedAt: new Date().toISOString(), counts, alerts };
      const dates = Object.keys(store).sort();
      while (dates.length > 60) {
        const drop = dates.shift();
        if (drop) delete store[drop];
      }
      await redis.set(LOG_KEY, JSON.stringify(store));
    }

    // Email when there's something HIGH — or when the data-health sentinel
    // found a problem (a broken feed must surface even on an otherwise calm
    // day, or it stays silently broken). ALERT_EMAIL_TO may be a
    // comma-separated list — GmailApp sends to all. Queued to the Gmail
    // outbox; id is per-date so a day's digest is enqueued at most once.
    let emailed = false;
    const healthProblems = opts?.dataHealth ? opts.dataHealth.problemCount : 0;
    const alertTo = (process.env.ALERT_EMAIL_TO || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
    // Overnight auto-rescores (last 36h) ride along in the email.
    let rescores: RecentRescore[] = [];
    try {
      const rsRaw = await redis.get("pm:rescore-state");
      const rs = rsRaw ? (JSON.parse(rsRaw) as { recent?: RecentRescore[] }) : null;
      const cutoff = Date.now() - 36 * 3_600_000;
      rescores = (rs?.recent ?? []).filter((r) => Date.parse(r.at) > cutoff);
    } catch {
      rescores = [];
    }

    if ((counts.high > 0 || healthProblems > 0 || rescores.length > 0) && alertTo) {
      const subject =
        counts.high > 0
          ? `PM alerts — ${counts.high} need attention (${today})`
          : rescores.length > 0
          ? `PM digest — ${rescores.length} auto-rescore${rescores.length === 1 ? "" : "s"} overnight (${today})`
          : `PM data health — ${healthProblems} feed issue${healthProblems === 1 ? "" : "s"} (${today})`;
      emailed = await enqueueMail({
        id: `digest-${today}`,
        to: alertTo,
        subject,
        text: renderDigestText(alerts, counts, today, opts?.dataHealth, rescores),
        queuedAt: new Date().toISOString(),
      });
    }
    return { ran: true, total: counts.total, emailed };
  } catch (e) {
    log.error("failed:", e);
    return { ran: false, total: 0, emailed: false, error: e instanceof Error ? e.message : "error" };
  }
}
