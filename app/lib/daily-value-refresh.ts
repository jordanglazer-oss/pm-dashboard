/**
 * Server-side freshness for the PIM performance ledger (pm:pim-performance).
 *
 * Why this exists: the ledger was only ever appended by /api/update-daily-value,
 * and the only callers were CLIENT pages — the PIM Model auto-refresh and the
 * Performance tracker's Refresh button. Nothing server-side ran it, so the
 * Brief's "Alpha vs core" cell (which reads the alpha / core series out of
 * that ledger) sat flat for as long as nobody opened the Positioning page.
 * Now the ledger is kept fresh from three server paths:
 *
 *   1. GET /api/daily-summary  — every Brief load, when stale during/after
 *      market hours (intraday movement).
 *   2. POST /api/morning-brief — every brief regeneration, same gate.
 *   3. /api/cron/daily-value   — weekday after-close, unconditional, so the
 *      settled session is captured even if nobody opened the app.
 *
 * The heavy lifting stays in the route (one implementation of the
 * recalculation); this module only decides WHETHER to run it, bounds how long
 * a page load waits for it, and lets a slow refresh finish after the response.
 *
 * Redis: reads pm:pim-performance for the staleness check; the refresh itself
 * writes only what /api/update-daily-value already wrote (pm:pim-performance,
 * pm:appendix-daily-values), through that route's own read-modify-write.
 */

import { after } from "next/server";
import { getRedis } from "./redis";
import { getTodayET, isMarketOpenOrAfterET } from "./market-hours";
import { POST as runUpdateDailyValue } from "@/app/api/update-daily-value/route";

export const PERF_STALE_MS = 15 * 60 * 1000;

export type RefreshOutcome = {
  ran: boolean;
  /** "fresh" | "closed" | "forced" | "stale" | "timed-out" | "error" */
  reason: string;
  lastUpdated: string | null;
  updates?: number;
  message?: string;
  error?: string;
};

type LedgerHead = { lastUpdated: string | null; alphaLastDate: string | null; coreLastDate: string | null };

async function readLedgerHead(): Promise<LedgerHead> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:pim-performance");
    if (!raw) return { lastUpdated: null, alphaLastDate: null, coreLastDate: null };
    const parsed = JSON.parse(raw) as {
      lastUpdated?: string;
      models?: { groupId?: string; profile?: string; history?: { date?: string }[] }[];
    };
    const lastDate = (profile: string): string | null => {
      const h = parsed.models?.find((m) => m.groupId === "pim" && m.profile === profile)?.history;
      const d = h && h.length ? h[h.length - 1]?.date : null;
      return typeof d === "string" ? d.slice(0, 10) : null;
    };
    return {
      lastUpdated: typeof parsed.lastUpdated === "string" ? parsed.lastUpdated : null,
      alphaLastDate: lastDate("alpha"),
      coreLastDate: lastDate("core"),
    };
  } catch {
    return { lastUpdated: null, alphaLastDate: null, coreLastDate: null };
  }
}

async function readLastUpdated(): Promise<string | null> {
  return (await readLedgerHead()).lastUpdated;
}

/** The most recent weekday strictly before today (ET) — the last completed
 *  session. Ignores holidays: the morning after one, every pre-open load
 *  re-runs a recalculation that finds nothing to add (no write) — a few
 *  wasted Yahoo calls on a handful of mornings a year, until the open. */
function previousWeekdayET(): string {
  const [y, m, d] = getTodayET().split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, 12));
  do {
    dt.setUTCDate(dt.getUTCDate() - 1);
  } while (dt.getUTCDay() === 0 || dt.getUTCDay() === 6);
  return dt.toISOString().slice(0, 10);
}

/** Run the recalculation now (no gate). */
export async function refreshDailyValues(): Promise<RefreshOutcome> {
  const lastUpdated = await readLastUpdated();
  try {
    const res = await runUpdateDailyValue();
    const json = (await res.json()) as { ok?: boolean; updates?: unknown[]; message?: string; error?: string };
    if (!res.ok || json.error) {
      return { ran: true, reason: "error", lastUpdated, error: json.error ?? `HTTP ${res.status}` };
    }
    return { ran: true, reason: "forced", lastUpdated, updates: Array.isArray(json.updates) ? json.updates.length : 0, message: json.message };
  } catch (e) {
    return { ran: true, reason: "error", lastUpdated, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Refresh only when it can produce a different number: after the open when
 * the ledger is older than PERF_STALE_MS, or before the open when the alpha /
 * core series are missing the last completed session (the recalculation
 * never records a pre-open "today", so this only ever adds that session). Waits at most `maxWaitMs`; a slower refresh keeps running
 * after the response via next/server `after()` so the NEXT load is fresh.
 */
export async function ensureDailyValuesFresh(opts: { maxWaitMs?: number; force?: boolean } = {}): Promise<RefreshOutcome> {
  const maxWaitMs = opts.maxWaitMs ?? 12_000;
  const head = await readLedgerHead();
  const lastUpdated = head.lastUpdated;
  const ageMs = lastUpdated ? Date.now() - Date.parse(lastUpdated) : Infinity;

  if (!opts.force) {
    if (!isMarketOpenOrAfterET()) {
      // Before the open (and on weekends) there is no "today" to add, but the
      // last completed session may still be missing — the after-close cron
      // can fail or be skipped, and then the morning brief would show the
      // previous day's spread again. Catch up that session pre-market; the
      // recalculation itself never writes a pre-open "today".
      const want = previousWeekdayET();
      const behind = [head.alphaLastDate, head.coreLastDate].some((d) => d != null && d < want);
      if (!behind) return { ran: false, reason: "closed", lastUpdated };
    } else if (ageMs < PERF_STALE_MS) {
      return { ran: false, reason: "fresh", lastUpdated };
    }
  }

  const work = refreshDailyValues();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), maxWaitMs);
  });
  const result = await Promise.race([work, timeout]);
  if (timer) clearTimeout(timer);
  if (result === "timeout") {
    // Let the recalculation finish after the response is sent.
    try {
      after(() => work.catch(() => undefined));
    } catch {
      // Outside a request scope (e.g. a script) `after` throws; the promise
      // still runs to completion on its own.
    }
    return { ran: true, reason: "timed-out", lastUpdated, message: `refresh still running after ${maxWaitMs}ms; next load will be fresh` };
  }
  return { ...result, reason: opts.force ? "forced" : "stale" };
}
