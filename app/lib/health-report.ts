import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { listBackupBlobs } from "./backup-store";
import { enqueueMail } from "./mail-outbox";
import { listFlags } from "./agents/flags";
import { STOP_USD, monthKey } from "./agents/spend";
import type { PimPerformanceData } from "./pim-types";

/**
 * Weekly health check — "are the safety nets actually working?"
 *
 * READ-ONLY over every existing pm:* key. The only writes are:
 *   - pm:mail-outbox (one entry, id `health-report-<date>`, via enqueueMail —
 *     read-merge-write, idempotent by id), when `email: true`;
 *   - pm:health-report:<YYYY-MM-DD> (NEW, small summary, 400-day expiry),
 *     when `record: true`.
 * The manual admin route passes neither, so it writes nothing at all.
 *
 * Every check is independent and wrapped: one failing check shows up as an
 * amber "could not check" line, never as a failed report.
 */

const log = createLogger("Health-report");

export type HealthStatus = "green" | "amber" | "red";

export type HealthLine = {
  id: string;
  title: string;
  status: HealthStatus;
  /** One plain-English sentence for the email. */
  summary: string;
  /** Optional extra lines (shown indented in the email). */
  details?: string[];
  data?: unknown;
};

export type HealthReport = {
  date: string; // ET date the report was built
  at: string;
  overall: HealthStatus;
  lines: HealthLine[];
};

const REDIS_TIER_BYTES = 250 * 1024 * 1024;
const RECORD_PREFIX = "pm:health-report:";
const RECORD_EXPIRE_SEC = 400 * 86_400;

type Redis = Awaited<ReturnType<typeof getRedis>>;

// ── dates ──────────────────────────────────────────────────────────────

function etParts(now: Date): { date: string; minutes: number } {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: hour * 60 + Number(p.minute) };
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isWeekend(iso: string): boolean {
  const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
  return wd === 0 || wd === 6;
}

/** The newest weekday whose job should already have run, given the job runs
 *  at `cutoffMinutesET` (minutes after midnight, New York time). Not
 *  holiday-aware: one weekday behind reads amber ("maybe a holiday"). */
export function expectedWeekday(now: Date, cutoffMinutesET: number): string {
  const { date, minutes } = etParts(now);
  let d = minutes >= cutoffMinutesET ? date : addDays(date, -1);
  while (isWeekend(d)) d = addDays(d, -1);
  return d;
}

/** Weekdays after `last` up to and including `expected` (0 = up to date). */
export function weekdaysBehind(last: string, expected: string): number {
  if (!last || last >= expected) return 0;
  let n = 0;
  for (let d = addDays(last, 1); d <= expected && n < 400; d = addDays(d, 1)) if (!isWeekend(d)) n++;
  return n;
}

function behindStatus(behind: number): HealthStatus {
  return behind === 0 ? "green" : behind === 1 ? "amber" : "red";
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const hoursText = (h: number) => (h < 48 ? `${Math.round(h)} hours` : `${(h / 24).toFixed(1)} days`);

async function scanKeys(redis: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const k of redis.scanIterator({ MATCH: match, COUNT: 500 })) {
    if (Array.isArray(k)) keys.push(...k);
    else keys.push(k);
  }
  return keys;
}

function parse<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function safe(id: string, title: string, fn: () => Promise<HealthLine | HealthLine[]>): Promise<HealthLine[]> {
  try {
    const out = await fn();
    return Array.isArray(out) ? out : [out];
  } catch (e) {
    log.error(`${id} check failed:`, e);
    return [{ id, title, status: "amber", summary: `Could not check this (${e instanceof Error ? e.message : String(e)}).` }];
  }
}

// ── checks ─────────────────────────────────────────────────────────────

async function checkBackups(now: Date): Promise<HealthLine[]> {
  const backups = await listBackupBlobs(); // newest first
  const newest = backups[0];
  if (!newest) {
    return [{ id: "backup", title: "Nightly backup", status: "red", summary: "No backups exist. There is no copy of the data outside the live database." }];
  }
  const ageH = (now.getTime() - Date.parse(newest.uploadedAt)) / 3_600_000;
  const weekAgo = now.getTime() - 7 * 86_400_000;
  const lastWeek = backups.filter((b) => Date.parse(b.uploadedAt) >= weekAgo);
  const prior = backups.slice(1, 8).map((b) => b.sizeBytes).sort((a, b) => a - b);
  const median = prior.length ? prior[Math.floor(prior.length / 2)] : 0;
  const shrank = median > 0 && newest.sizeBytes < median * 0.7;

  const ageStatus: HealthStatus = ageH <= 30 ? "green" : ageH <= 50 ? "amber" : "red";
  const countStatus: HealthStatus = lastWeek.length >= 6 ? "green" : lastWeek.length >= 4 ? "amber" : "red";
  const worst = (...s: HealthStatus[]): HealthStatus => (s.includes("red") ? "red" : s.includes("amber") ? "amber" : "green");
  const status = worst(ageStatus, countStatus, shrank ? "amber" : "green");

  const parts = [
    `Newest backup is ${hoursText(ageH)} old (${mb(newest.sizeBytes)}).`,
    `${lastWeek.length} of the last 7 nights were saved.`,
  ];
  if (shrank) parts.push(`It is noticeably smaller than usual (typical ${mb(median)}), so some data may be missing from it.`);
  if (ageStatus !== "green") parts.push("The nightly backup job has not run recently. Avoid large changes until a backup succeeds.");
  return [
    {
      id: "backup",
      title: "Nightly backup",
      status,
      summary: parts.join(" "),
      data: { newest, ageHours: Math.round(ageH * 10) / 10, last7Days: lastWeek.length, total: backups.length, typicalBytes: median },
    },
  ];
}

async function checkRedisMemory(redis: Redis): Promise<HealthLine[]> {
  const keys = await scanKeys(redis, "pm:*");
  const sizes: { key: string; bytes: number }[] = [];
  const CHUNK = 100;
  for (let i = 0; i < keys.length; i += CHUNK) {
    const slice = keys.slice(i, i + CHUNK);
    const lens = await Promise.all(
      slice.map(async (k) => {
        try {
          const n = Number(await redis.strLen(k)); // length only — never transfers the value
          return Number.isFinite(n) ? n : -1;
        } catch {
          return -1; // non-string key or unsupported command
        }
      }),
    );
    slice.forEach((key, j) => sizes.push({ key, bytes: lens[j] }));
  }
  const valueBytes = sizes.reduce((s, x) => s + Math.max(0, x.bytes), 0);
  const largest = [...sizes].sort((a, b) => b.bytes - a.bytes).slice(0, 15).filter((s) => s.bytes > 0);

  let used: number | null = null;
  let max: number | null = null;
  try {
    const info = String(await redis.info("memory"));
    const field = (name: string) => {
      const m = info.match(new RegExp(`^${name}:(\\d+)`, "m"));
      return m ? Number(m[1]) : null;
    };
    used = field("used_memory");
    const mx = field("maxmemory");
    max = mx && mx > 0 ? mx : null;
  } catch {
    /* INFO not available on every provider — fall back to the value total */
  }
  const limit = max ?? REDIS_TIER_BYTES;
  const measured = used ?? valueBytes;
  const pct = (measured / limit) * 100;
  const status: HealthStatus = pct < 60 ? "green" : pct < 80 ? "amber" : "red";
  const how = used == null ? " (estimated from the stored values; the provider did not report memory directly)" : "";
  const advice =
    status === "green" ? "" : status === "amber" ? " Getting fuller — worth a tidy-up before it becomes a problem." : " Close to full: when it fills, saves start failing. Needs attention now.";
  return [
    {
      id: "redis-memory",
      title: "Database memory",
      status,
      summary: `Using ${mb(measured)} of ${mb(limit)} (${Math.round(pct)}%)${how}.${advice}`,
      details: largest.slice(0, 5).map((s) => `${s.key}: ${mb(s.bytes)}`),
      data: { usedBytes: used, maxBytes: max, limitBytes: limit, valueBytes, keyCount: keys.length, largestKeys: largest.map((s) => ({ ...s, mb: +(s.bytes / 1024 / 1024).toFixed(2) })) },
    },
  ];
}

async function checkAiSpend(redis: Redis, now: Date): Promise<HealthLine[]> {
  const month = monthKey(now);
  const keys = await scanKeys(redis, `pm:agent-spend:${month}:*`);
  const vals = keys.length ? await redis.mGet(keys) : [];
  let total = 0;
  const byWatcher: Record<string, { usd: number; calls: number }> = {};
  keys.forEach((k, i) => {
    const n = Number(vals[i] ?? 0);
    if (!Number.isFinite(n)) return;
    const suffix = k.slice(`pm:agent-spend:${month}:`.length);
    if (suffix === "total") total = n;
    else if (suffix.startsWith("usd:")) (byWatcher[suffix.slice(4)] ??= { usd: 0, calls: 0 }).usd = n;
    else if (suffix.startsWith("calls:")) (byWatcher[suffix.slice(6)] ??= { usd: 0, calls: 0 }).calls = n;
  });
  const day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
  const projected = day > 0 ? (total / day) * daysInMonth : total;
  const status: HealthStatus = total >= STOP_USD ? "red" : total >= STOP_USD * 0.67 || projected >= STOP_USD ? "amber" : "green";
  const tail =
    status === "red"
      ? " The watchers have hit the stop line and will not run again until the 1st."
      : status === "amber"
        ? ` At this pace the month would end near $${projected.toFixed(0)}; the watchers stop themselves at $${STOP_USD}.`
        : "";
  const top = Object.entries(byWatcher)
    .sort((a, b) => b[1].usd - a[1].usd)
    .slice(0, 5)
    .map(([id, v]) => `${id}: $${v.usd.toFixed(2)} over ${v.calls} calls`);
  return [
    {
      id: "ai-spend",
      title: "AI watchers' spending",
      status,
      summary: `$${total.toFixed(2)} spent this month of the $${STOP_USD} stop line.${tail}`,
      details: top,
      data: { month, totalUsd: total, stopUsd: STOP_USD, projectedUsd: Math.round(projected * 100) / 100, byWatcher },
    },
  ];
}

async function newestDatedKey(redis: Redis, prefix: string): Promise<string | null> {
  const keys = await scanKeys(redis, `${prefix}*`);
  const dates = keys.map((k) => k.slice(prefix.length)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  return dates.length ? dates[dates.length - 1] : null;
}

function jobLine(id: string, title: string, last: string | null, expected: string, what: string): HealthLine {
  if (!last) return { id, title, status: "red", summary: `No record of it ever running. ${what}` };
  const behind = weekdaysBehind(last, expected);
  const status = behindStatus(behind);
  const summary =
    behind === 0
      ? `Last ran ${last} — on schedule.`
      : behind === 1
        ? `Last ran ${last}, one weekday late (may just be a market holiday).`
        : `Last ran ${last} — ${behind} weekdays missed. ${what}`;
  return { id, title, status, summary, data: { last, expected, weekdaysBehind: behind } };
}

async function checkJobs(redis: Redis, now: Date, perf: PimPerformanceData | null, newestBackupAt: string | null): Promise<HealthLine[]> {
  const out: HealthLine[] = [];

  // Backup — 06:00 UTC daily. Covered in detail above; repeated here so the
  // job list is complete.
  if (newestBackupAt) {
    const ageH = (now.getTime() - Date.parse(newestBackupAt)) / 3_600_000;
    out.push({
      id: "job-backup",
      title: "Job: nightly backup",
      status: ageH <= 30 ? "green" : ageH <= 50 ? "amber" : "red",
      summary: `Last finished ${newestBackupAt.slice(0, 16).replace("T", " ")} UTC.`,
      data: { last: newestBackupAt, ageHours: Math.round(ageH * 10) / 10 },
    });
  } else {
    out.push({ id: "job-backup", title: "Job: nightly backup", status: "red", summary: "No record of it ever finishing." });
  }

  // Daily value — 21:30 UTC weekdays (≈16:30–17:30 ET). Use 18:00 ET as the
  // "should be done by" line so DST never causes a false alarm.
  const expectedClose = expectedWeekday(now, 18 * 60);
  let lastPerf: string | null = null;
  for (const m of perf?.models ?? []) {
    const d = m.history?.[m.history.length - 1]?.date;
    if (d && (!lastPerf || d > lastPerf)) lastPerf = d;
  }
  out.push(jobLine("job-daily-value", "Job: daily performance update", lastPerf, expectedClose, "Performance numbers are not being updated."));

  // Holdings watch — 21:45 UTC weekdays; skips (writes nothing) on a holiday.
  const lastHoldings = await newestDatedKey(redis, "pm:agent-run:holdings-day:");
  out.push(jobLine("job-holdings-watch", "Job: holdings watch", lastHoldings, expectedClose, "Big moves in held names are not being checked."));

  // Stance watch — 22:00 UTC weekdays.
  const stance = parse<{ date?: string } | null>(await redis.get("pm:agent-state:stance"), null);
  out.push(jobLine("job-stance-watch", "Job: stance & hedge-window watch", stance?.date ?? null, expectedClose, "Regime and hedge-window changes are not being watched."));

  // Sunday memo — Sundays 22:00 UTC.
  const lastMemo = await newestDatedKey(redis, "pm:agent-memo:");
  if (!lastMemo) {
    out.push({ id: "job-sunday-memo", title: "Job: Sunday memo", status: "red", summary: "No memo has ever been written." });
  } else {
    const ageDays = (now.getTime() - Date.parse(`${lastMemo}T22:00:00Z`)) / 86_400_000;
    const status: HealthStatus = ageDays <= 8 ? "green" : ageDays <= 15 ? "amber" : "red";
    out.push({
      id: "job-sunday-memo",
      title: "Job: Sunday memo",
      status,
      summary: status === "green" ? `Last memo ${lastMemo} — on schedule.` : `Last memo ${lastMemo} — ${Math.floor(ageDays / 7)} Sunday(s) missed.`,
      data: { last: lastMemo, ageDays: Math.round(ageDays * 10) / 10 },
    });
  }
  return out;
}

async function checkFlags(): Promise<HealthLine[]> {
  const open = (await listFlags()).filter((f) => f.status === "open");
  const by = { high: 0, medium: 0, low: 0 } as Record<string, number>;
  for (const f of open) by[f.priority] = (by[f.priority] ?? 0) + 1;
  const status: HealthStatus = by.high > 0 ? "amber" : "green";
  return [
    {
      id: "flags",
      title: "Open watcher flags",
      status,
      summary:
        open.length === 0
          ? "Nothing waiting for you on the Monitor page."
          : `${open.length} open on the Monitor page: ${by.high} high, ${by.medium} medium, ${by.low} low priority.${by.high ? " The high ones are worth a look." : ""}`,
      details: open
        .filter((f) => f.priority === "high")
        .slice(0, 5)
        .map((f) => `${f.title}`),
      data: { open: open.length, byPriority: by },
    },
  ];
}

type SeriesGroup = { id: string; profiles?: Record<string, unknown> };

/**
 * Does the weekday daily-value job (`app/api/update-daily-value/route.ts`)
 * actually update this series? Mirrors that job's own skip rules: the group
 * must exist in pm:pim-models; core / alpha / thematic / stocks are PIM-only;
 * any other profile must be one of the group's profiles (so the old
 * `core-balanced`-style series of the other groups, seeded once and never
 * updated, are not judged as "behind"); a series with < 2 points is skipped.
 * Keep in step with that loop.
 */
export function isDailyUpdatedSeries(
  m: { groupId: string; profile: string; history?: unknown[] },
  groups: SeriesGroup[],
): boolean {
  if ((m.history?.length ?? 0) < 2) return false;
  const group = groups.find((g) => g.id === m.groupId);
  if (!group) return false;
  if (["core", "alpha", "thematic", "stocks"].includes(m.profile)) return m.groupId === "pim";
  return !!group.profiles?.[m.profile];
}

export function checkSeries(perf: PimPerformanceData | null, now: Date, groups: SeriesGroup[] | null): HealthLine[] {
  const expected = expectedWeekday(now, 18 * 60);
  const all = perf?.models ?? [];
  if (all.length === 0) {
    return [{ id: "series", title: "Performance series", status: "red", summary: "No performance series found." }];
  }
  // Models unreadable → judge every series (never hide a gap on a read failure).
  const models = groups ? all.filter((m) => isDailyUpdatedSeries(m, groups)) : all;
  const ignored = all.length - models.length;
  const ignoredNote = ignored > 0 ? ` (${ignored} older series the daily update does not maintain are not checked.)` : "";
  if (models.length === 0) {
    return [{ id: "series", title: "Performance series", status: "red", summary: `No series the daily update maintains were found.${ignoredNote}` }];
  }
  const rows = models.map((m) => {
    const last = m.history?.[m.history.length - 1]?.date ?? "";
    return { series: `${m.groupId}|${m.profile}`, last, behind: last ? weekdaysBehind(last, expected) : 999 };
  });
  const stale = rows.filter((r) => r.behind > 0).sort((a, b) => b.behind - a.behind);
  const worstBehind = stale[0]?.behind ?? 0;
  const status = behindStatus(worstBehind);
  return [
    {
      id: "series",
      title: "Performance series",
      status,
      summary:
        stale.length === 0
          ? `All ${rows.length} tracked series are up to date (through ${expected}).${ignoredNote}`
          : `${stale.length} of ${rows.length} tracked series are behind (should reach ${expected}).${worstBehind >= 2 ? " A daily update was missed — those returns are not being recorded." : ""}${ignoredNote}`,
      details: stale.slice(0, 10).map((r) => `${r.series}: last ${r.last || "never"}`),
      data: { expected, series: rows, ignored, modelsRead: !!groups },
    },
  ];
}

async function checkOutbox(redis: Redis, now: Date): Promise<HealthLine[]> {
  const list = parse<{ id: string; queuedAt: string }[]>(await redis.get("pm:mail-outbox"), []);
  const pending = Array.isArray(list) ? list : [];
  const oldest = pending.reduce<string | null>((o, m) => (!o || m.queuedAt < o ? m.queuedAt : o), null);
  const ageH = oldest ? (now.getTime() - Date.parse(oldest)) / 3_600_000 : 0;
  const status: HealthStatus = ageH <= 2 ? "green" : ageH <= 24 ? "amber" : "red";
  return [
    {
      id: "outbox",
      title: "Email sending",
      status,
      summary:
        pending.length === 0
          ? "No emails stuck waiting to be sent."
          : status === "green"
            ? `${pending.length} email(s) queued, the oldest ${Math.round(ageH * 60)} minutes ago — normal.`
            : `${pending.length} email(s) waiting, the oldest for ${hoursText(ageH)}. The Gmail script that sends them may have stopped.`,
      data: { pending: pending.length, oldestQueuedAt: oldest },
    },
  ];
}

// ── build / format / send ─────────────────────────────────────────────

export async function buildHealthReport(now = new Date()): Promise<HealthReport> {
  const redis = await getRedis();
  const perf = parse<PimPerformanceData | null>(await redis.get("pm:pim-performance").catch(() => null), null);
  const pimModels = parse<{ groups?: SeriesGroup[] } | null>(await redis.get("pm:pim-models").catch(() => null), null);
  const seriesGroups = Array.isArray(pimModels?.groups) && pimModels.groups.length > 0 ? pimModels.groups : null;

  const backupLines = await safe("backup", "Nightly backup", () => checkBackups(now));
  const newestBackupAt = (backupLines[0]?.data as { newest?: { uploadedAt?: string } } | undefined)?.newest?.uploadedAt ?? null;

  const groups = await Promise.all([
    safe("redis-memory", "Database memory", () => checkRedisMemory(redis)),
    safe("ai-spend", "AI watchers' spending", () => checkAiSpend(redis, now)),
    safe("jobs", "Scheduled jobs", () => checkJobs(redis, now, perf, newestBackupAt)),
    safe("series", "Performance series", async () => checkSeries(perf, now, seriesGroups)),
    safe("flags", "Open watcher flags", () => checkFlags()),
    safe("outbox", "Email sending", () => checkOutbox(redis, now)),
  ]);
  const lines = [...backupLines, ...groups.flat()];
  const overall: HealthStatus = lines.some((l) => l.status === "red") ? "red" : lines.some((l) => l.status === "amber") ? "amber" : "green";
  return { date: etParts(now).date, at: now.toISOString(), overall, lines };
}

const LABEL: Record<HealthStatus, string> = { green: "GREEN", amber: "AMBER", red: "RED" };

export function formatHealthEmail(r: HealthReport): { subject: string; text: string } {
  const counts = { red: 0, amber: 0, green: 0 } as Record<HealthStatus, number>;
  for (const l of r.lines) counts[l.status]++;
  const headline =
    r.overall === "green"
      ? "Everything checked is working."
      : r.overall === "amber"
        ? `${counts.amber} thing(s) need a look soon; nothing is broken.`
        : `${counts.red} thing(s) are NOT working and need attention.`;
  const order: HealthStatus[] = ["red", "amber", "green"];
  const body: string[] = [headline, "", "GREEN = fine · AMBER = keep an eye on it · RED = needs fixing", ""];
  for (const s of order) {
    for (const l of r.lines.filter((x) => x.status === s)) {
      body.push(`[${LABEL[l.status]}] ${l.title}`, `  ${l.summary}`);
      for (const d of l.details ?? []) body.push(`    - ${d}`);
      body.push("");
    }
  }
  body.push("Full details: https://pm-dashboard-7rr9.vercel.app/api/admin/health-report");
  const subject = `Dashboard weekly health check — ${LABEL[r.overall]} — ${r.date}`;
  return { subject, text: body.join("\n") };
}

function recipients(): string {
  return (process.env.ALERT_EMAIL_TO || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(",");
}

export async function runHealthReport(opts: { email?: boolean; record?: boolean } = {}): Promise<{ report: HealthReport; emailed: boolean; recorded: boolean; note?: string }> {
  const report = await buildHealthReport();
  let emailed = false;
  let recorded = false;
  let note: string | undefined;

  if (opts.email) {
    const to = recipients();
    if (!to) note = "ALERT_EMAIL_TO is not set — nothing emailed.";
    else {
      try {
        const { subject, text } = formatHealthEmail(report);
        emailed = await enqueueMail({ id: `health-report-${report.date}`, to, subject, text, queuedAt: new Date().toISOString() });
        if (!emailed) note = "This week's report was already queued.";
      } catch (e) {
        log.error("could not queue the email:", e);
        note = "Could not queue the email.";
      }
    }
  }

  if (opts.record) {
    try {
      const small = { date: report.date, at: report.at, overall: report.overall, lines: report.lines.map(({ id, status, summary }) => ({ id, status, summary })) };
      await (await getRedis()).set(`${RECORD_PREFIX}${report.date}`, JSON.stringify(small), { EX: RECORD_EXPIRE_SEC });
      recorded = true;
    } catch (e) {
      log.error("could not save the record:", e);
    }
  }
  return { report, emailed, recorded, note };
}
