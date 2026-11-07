import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { computeAlerts, alertCounts, type Alert } from "@/app/lib/alerts";
import { loadAlertInputs } from "@/app/lib/alert-inputs";
import { enqueueMail } from "@/app/lib/mail-outbox";
import { isTradingWeekdayET } from "@/app/lib/market-calendar";
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

/** Most flags shown in full; the rest become a count. */
const MAX_FULL_FLAGS = 7;
/** Most "also watching" names listed on the one summary line. */
const MAX_WATCH_LINE = 6;

/** The terse form of an alert — its `short` when set, else derived from the
 *  title / detail so a new alert type still renders sensibly. */
function shortOf(a: Alert): { label: string; what: string; why?: string; next?: string } {
  const label = a.ticker ?? (a.category === "regime" ? "MARKET" : a.category.toUpperCase());
  if (a.short) return { label, ...a.short };
  const what = a.ticker ? a.title.replace(new RegExp(`^${a.ticker}\\s*[—-]\\s*`), "") : a.title;
  const why = a.detail ? a.detail.replace(/\s+/g, " ").trim() : undefined;
  return { label, what, why: why && why.length > 140 ? `${why.slice(0, 139)}…` : why };
}

/** Email order: a broken thesis first, then pre-registered exits, the
 *  market, eroding theses, technicals, overdue reviews. The in-app tile keeps
 *  computeAlerts' own order; this only decides what leads the email. */
const EMAIL_ORDER = ["verdict-", "kill-", "regime", "thesis-", "tech-", "reunderwrite-", "entry-"];
function emailRank(a: Alert): number {
  const i = EMAIL_ORDER.findIndex((pfx) => a.id.startsWith(pfx));
  return i === -1 ? EMAIL_ORDER.length : i;
}
function byImportance(alerts: Alert[], priority: Alert["priority"]): Alert[] {
  return alerts.filter((a) => a.priority === priority).sort((x, y) => emailRank(x) - emailRank(y));
}

/** "Nov 5" for a YYYY-MM-DD date. */
function shortDate(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  return isNaN(d.getTime()) ? date : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Problem lines only — a healthy feed set adds nothing to the email. */
function problemLines(dataHealth?: DataHealthReport): string[] {
  if (!dataHealth || dataHealth.problemCount === 0) return [];
  return dataHealth.lines.filter((l) => l.startsWith("⚠")).map((l) => l.replace(/^⚠\s*/, ""));
}

/**
 * Plain-text digest — the Gmail outbox sends text bodies via GmailApp.sendEmail.
 * Built to be read in under a minute: each high-priority flag is two or three
 * lines (what happened, why it matters, the next step), medium items share a
 * single "Also watching" line, and data health appears only when a feed is
 * broken. The full detail stays on the dashboard's alert tile.
 */
export function renderDigestText(
  alerts: Alert[],
  date: string,
  dataHealth?: DataHealthReport
): string {
  const high = byImportance(alerts, "high");
  const medium = byImportance(alerts, "medium");
  const lines: string[] = [];

  for (const a of high.slice(0, MAX_FULL_FLAGS)) {
    const s = shortOf(a);
    lines.push(`${s.label}  ${s.what}`);
    if (s.why) lines.push(`  ${s.why}`);
    if (s.next) lines.push(`  → ${s.next}`);
    lines.push("");
  }

  const watch = medium.map((a) => {
    const s = shortOf(a);
    return `${s.label} ${s.what.charAt(0).toLowerCase()}${s.what.slice(1)}`;
  });
  const extraHigh = Math.max(0, high.length - MAX_FULL_FLAGS);
  if (watch.length > 0 || extraHigh > 0) {
    const shown = watch.slice(0, MAX_WATCH_LINE);
    const more = watch.length - shown.length + extraHigh;
    const parts = [...shown, ...(more > 0 ? [`${more} more on the dashboard`] : [])];
    lines.push(`Also watching: ${parts.join(" · ")}`);
  }

  for (const p of problemLines(dataHealth)) lines.push(`Data issue: ${p}`);

  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
  lines.push(`pm-dashboard-7rr9.vercel.app · ${shortDate(date)}`);
  return lines.join("\n");
}

/** Subject = the headline: the flag count plus the most important one. */
export function digestSubject(alerts: Alert[], date: string, dataHealth?: DataHealthReport): string {
  const high = byImportance(alerts, "high");
  const when = shortDate(date);
  if (high.length > 0) {
    const top = shortOf(high[0]);
    const headline = `${top.label} ${top.what}`;
    const clipped = headline.length > 70 ? `${headline.slice(0, 69)}…` : headline;
    return `PM — ${high.length} flag${high.length === 1 ? "" : "s"} · ${clipped} (${when})`;
  }
  const problems = problemLines(dataHealth);
  const first = problems[0] ?? "feed check";
  const clipped = first.length > 60 ? `${first.slice(0, 59)}…` : first;
  return `PM — data issue: ${clipped}${problems.length > 1 ? ` (+${problems.length - 1})` : ""} (${when})`;
}

export async function runAlertDigest(opts?: {
  dataHealth?: DataHealthReport;
  /** Send even on a weekend — for a manual/admin trigger that wants the mail
   *  regardless of the calendar. The scheduled cron never passes this. */
  force?: boolean;
}): Promise<{
  ran: boolean;
  total: number;
  emailed: boolean;
  skipped?: "weekend";
  error?: string;
}> {
  try {
    const redis = await getRedis();
    const { thesis, transition, risk, context, killWatch, thesisVerdicts } = await loadAlertInputs();

    // Entry-ready pushes retired 2026-09-23 (the lanes replaced them).
    const alerts = computeAlerts({ thesis, transition, risk, context, killWatch, thesisVerdicts });
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
    // Weekend suppression — the alert LOG above is always written (history
    // stays complete and the in-app tile is unaffected); only the email is
    // held. A Saturday send would carry Friday's close and Sunday's would
    // repeat it; Monday's email carries Friday's close instead, so nothing is
    // lost. See app/lib/market-calendar for why this is not holiday-aware.
    if (!opts?.force && !isTradingWeekdayET()) {
      return { ran: true, total: counts.total, emailed: false, skipped: "weekend" };
    }

    if ((counts.high > 0 || healthProblems > 0) && alertTo) {
      emailed = await enqueueMail({
        id: `digest-${today}`,
        to: alertTo,
        subject: digestSubject(alerts, today, opts?.dataHealth),
        text: renderDigestText(alerts, today, opts?.dataHealth),
        queuedAt: new Date().toISOString(),
      });
    }
    return { ran: true, total: counts.total, emailed };
  } catch (e) {
    log.error("failed:", e);
    return { ran: false, total: 0, emailed: false, error: e instanceof Error ? e.message : "error" };
  }
}
