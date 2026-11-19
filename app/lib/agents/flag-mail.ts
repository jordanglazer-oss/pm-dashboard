import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { enqueueMail } from "@/app/lib/mail-outbox";
import { watcherDef } from "./registry";
import type { AgentFlag } from "./flags";

/**
 * Flag emails (Nov 2026) — before this a watcher's flag only showed on
 * /monitor and in the Brief queue; nothing told the team.
 *
 *   high   → emailed as soon as it is raised (at most MAX_NOW a day; the
 *            rest wait for the end-of-day email).
 *   medium → listed in the end-of-day email.
 *   low    → counted in the end-of-day email, detailed in the Sunday memo.
 *
 * The end-of-day email ALWAYS sends on a weekday, even with nothing new, so
 * a silent day reads as "checked, nothing found" rather than "did it run?".
 *
 * Redis: pm:mail-outbox (through enqueueMail — read-merge-write, idempotent
 * by id), the daily counter pm:agent-state:flag-mail-count:<date> (expires
 * after 3 days) and pm:agent-state:audit-email ({ lastSentAt, lastDate } —
 * safe to nuke: the next email then covers the last 24 hours). Reads flags
 * only; never writes one. Every helper is best-effort and never throws.
 */

const log = createLogger("Flag-mail");
const SITE = "https://pm-dashboard-7rr9.vercel.app";
const STATE_KEY = "pm:agent-state:audit-email";
const MAX_NOW = 8;

const etDay = (d: Date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(d);
const who = (id: string) => watcherDef(id)?.label ?? id;
function recipients(): string {
  return (process.env.ALERT_EMAIL_TO || "").split(",").map((s) => s.trim()).filter(Boolean).join(",");
}

function block(f: AgentFlag): string[] {
  const lines = [`${f.ticker ? `${f.ticker} — ` : ""}${f.title}`, `  ${f.detail}`];
  if (f.suggestion) lines.push(`  Consider: ${f.suggestion}`);
  if (f.factCheck && f.factCheck.verdict !== "supported" && f.factCheck.verdict !== "skipped") lines.push(`  Fact-check: ${f.factCheck.verdict}${f.factCheck.problems.length ? ` — ${f.factCheck.problems.join("; ")}` : ""}`);
  lines.push(`  Raised by: ${who(f.watcher)}`);
  return lines;
}

/** Email one HIGH flag right away. True when a mail was queued. */
export async function emailFlagNow(flag: AgentFlag): Promise<boolean> {
  try {
    if (flag.priority !== "high") return false;
    const to = recipients();
    if (!to) return false;
    const redis = await getRedis();
    const counter = `pm:agent-state:flag-mail-count:${etDay()}`;
    const n = await redis.incr(counter);
    if (n === 1) await redis.expire(counter, 3 * 86400);
    if (n > MAX_NOW) return false; // still in tonight's email
    return await enqueueMail({
      id: `flag-${flag.id}`,
      to,
      subject: `Portfolio flag — ${flag.ticker ? `${flag.ticker}: ` : ""}${flag.title}`.slice(0, 180),
      text: [...block(flag), "", `Open it: ${SITE}/monitor`, "", "This is a flag to look at, not an instruction. Nothing was traded or changed."].join("\n"),
      queuedAt: new Date().toISOString(),
    });
  } catch (e) {
    log.error("could not queue a flag email:", e);
    return false;
  }
}

export type AuditEmail = { subject: string; text: string; since: string; newCount: number; openCount: number };

/** Build tonight's email from the flag log. Pure — writes nothing. */
export function buildAuditEmail(flags: AgentFlag[], since: string, now: Date = new Date()): AuditEmail {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const fresh = flags.filter((f) => f.createdAt > since).sort((a, b) => rank[a.priority] - rank[b.priority] || a.createdAt.localeCompare(b.createdAt));
  const updated = flags.filter((f) => f.status === "open" && f.createdAt <= since && f.updatedAt > since && f.thread.some((m) => m.from === "watcher" && m.at > since));
  const open = flags.filter((f) => f.status === "open");
  const resolved = flags.filter((f) => f.status !== "open" && (f.resolvedAt ?? "") > since);
  const hi = fresh.filter((f) => f.priority === "high");
  const med = fresh.filter((f) => f.priority === "medium");
  const low = fresh.filter((f) => f.priority === "low");
  const day = etDay(now);
  const lines: string[] = [];

  if (!fresh.length && !updated.length) lines.push("The watchers ran and raised nothing new since the last email.");
  else lines.push(`${fresh.length} new flag${fresh.length === 1 ? "" : "s"}${updated.length ? `, ${updated.length} updated` : ""} since the last email.`);

  const section = (title: string, list: AgentFlag[]) => {
    if (!list.length) return;
    lines.push("", title, "-".repeat(title.length));
    for (const f of list) lines.push(...block(f), "");
    if (lines[lines.length - 1] === "") lines.pop();
  };
  section("NEEDS A LOOK (high)", hi);
  section("WORTH KNOWING (medium)", med);
  section("UPDATED", updated);
  if (low.length) lines.push("", `${low.length} low-priority item${low.length === 1 ? "" : "s"} — on the Monitor page and in Sunday's memo.`);

  const oldest = [...open].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  const openHigh = open.filter((f) => f.priority === "high").length;
  lines.push("", "STILL OPEN", "----------");
  lines.push(open.length ? `${open.length} open (${openHigh} high)${oldest ? `; the oldest was raised ${oldest.createdAt.slice(0, 10)}: ${oldest.ticker ? `${oldest.ticker} — ` : ""}${oldest.title}` : ""}.` : "Nothing open.");
  if (resolved.length) lines.push(`${resolved.length} resolved since the last email.`);
  lines.push("", `Monitor: ${SITE}/monitor`, "", "Flags are things to look at, not instructions. Nothing was traded or changed.");

  return {
    subject: `Portfolio audit ${day} — ${hi.length ? `${hi.length} need a look` : fresh.length ? `${fresh.length} new` : "nothing new"}`,
    text: lines.join("\n"),
    since,
    newCount: fresh.length,
    openCount: open.length,
  };
}

/** When the last end-of-day email went out (24 hours ago if never / unreadable). */
export async function auditSince(): Promise<string> {
  const fallback = new Date(Date.now() - 86_400_000).toISOString();
  try {
    const raw = await (await getRedis()).get(STATE_KEY);
    const at = raw ? (JSON.parse(raw) as { lastSentAt?: string }).lastSentAt : undefined;
    return typeof at === "string" && !Number.isNaN(Date.parse(at)) ? at : fallback;
  } catch {
    return fallback;
  }
}

/** Queue tonight's email (once per Eastern day) and move the marker. */
export async function sendAuditEmail(flags: AgentFlag[]): Promise<{ ok: boolean; queued: boolean; reason?: string; email?: AuditEmail }> {
  try {
    const to = recipients();
    if (!to) return { ok: false, queued: false, reason: "ALERT_EMAIL_TO is not set" };
    const now = new Date();
    const email = buildAuditEmail(flags, await auditSince(), now);
    const queued = await enqueueMail({ id: `audit-eod-${etDay(now)}`, to, subject: email.subject, text: email.text, queuedAt: now.toISOString() });
    if (queued) await (await getRedis()).set(STATE_KEY, JSON.stringify({ lastSentAt: now.toISOString(), lastDate: etDay(now) }));
    return { ok: true, queued, reason: queued ? undefined : "today's email is already queued", email };
  } catch (e) {
    log.error("end-of-day email failed:", e);
    return { ok: false, queued: false, reason: e instanceof Error ? e.message : String(e) };
  }
}
