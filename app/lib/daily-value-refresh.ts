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
import { isMarketOpenOrAfterET } from "./market-hours";
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

async function readLastUpdated(): Promise<string | null> {
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:pim-performance");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { lastUpdated?: string };
    return typeof parsed.lastUpdated === "string" ? parsed.lastUpdated : null;
  } catch {
    return null;
  }
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
 * Refresh only when it can produce a different number: on a weekday at or
 * after the open (pre-market Yahoo still reports yesterday's close, so a
 * refresh then would mislabel it), and only when the ledger is older than
 * PERF_STALE_MS. Waits at most `maxWaitMs`; a slower refresh keeps running
 * after the response via next/server `after()` so the NEXT load is fresh.
 */
export async function ensureDailyValuesFresh(opts: { maxWaitMs?: number; force?: boolean } = {}): Promise<RefreshOutcome> {
  const maxWaitMs = opts.maxWaitMs ?? 12_000;
  const lastUpdated = await readLastUpdated();
  const ageMs = lastUpdated ? Date.now() - Date.parse(lastUpdated) : Infinity;

  if (!opts.force) {
    if (!isMarketOpenOrAfterET()) return { ran: false, reason: "closed", lastUpdated };
    if (ageMs < PERF_STALE_MS) return { ran: false, reason: "fresh", lastUpdated };
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
