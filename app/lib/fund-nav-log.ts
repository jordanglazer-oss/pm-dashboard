/**
 * pm:fund-nav-log — the dashboard's OWN record of every mutual fund's daily
 * NAV and every distribution (Nov 2026).
 *
 * Why keep our own: the price feed's distribution-adjusted history is
 * RESCALED each time a fund pays a new distribution, so a figure shown last
 * month can change; and the feed is unofficial and could disappear. A log of
 * what the NAV and the distribution actually were on each day never changes,
 * can be checked line by line against the fund company or FactSet, and lets
 * returns be recomputed from our own data whatever the source becomes.
 *
 * Shape (one small key — about 25 bytes per fund per day):
 *   { funds: { [CODE]: { nav: [[date, nav], …] ascending,
 *                        dists: [{ date, pctOfNav, perUnit, at }],
 *                        firstLoggedAt } },
 *     updatedAt }
 *
 * APPEND-ONLY. `updateFundNavLog` only ADDS: a date already on file keeps the
 * NAV first recorded for it (a later different reading from the feed is
 * counted in `changedUpstream`, never written), and a distribution already on
 * file for a date is left alone. Nothing is ever removed. A fund that leaves
 * the models keeps its history. Single writer: the weekday daily-value cron
 * (write-aside, never throws) and the admin route that seeds it.
 *
 * Reads NOTHING the performance engine depends on, and nothing reads it for a
 * recorded number yet — it is the audit trail and the cross-check.
 * BACKED UP (not in the backup exclude list).
 */

import { getRedis } from "./redis";
import { createLogger } from "./logger";
import type { PimModelData } from "./pim-types";
import { bareFundCode, fetchFundNav, findDistributions, isFundCode, totalReturnIndex, ytdReturn, type FundDistribution, type NavPoint } from "./fund-nav";

const log = createLogger("Fund-nav-log");

export const FUND_NAV_LOG_KEY = "pm:fund-nav-log";
/** First run: about five years of history. Later runs only need the recent window. */
const SEED_RECORDS = 1300;
const DAILY_RECORDS = 40;

export type LoggedDistribution = FundDistribution & { at: string };
export type FundLogEntry = { nav: [string, number][]; dists: LoggedDistribution[]; firstLoggedAt: string };
export type FundNavLog = { funds: Record<string, FundLogEntry>; updatedAt: string };

export async function readFundNavLog(): Promise<FundNavLog | null> {
  const raw = await (await getRedis()).get(FUND_NAV_LOG_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as FundNavLog;
  if (!parsed || typeof parsed !== "object" || typeof parsed.funds !== "object" || parsed.funds == null) throw new Error("pm:fund-nav-log is not readable");
  return parsed;
}

/** Every mutual fund in any model group. */
export function fundCodesInModels(models: PimModelData | null): string[] {
  const set = new Set<string>();
  for (const g of models?.groups ?? []) for (const h of g.holdings ?? []) if (isFundCode(h.symbol)) set.add(bareFundCode(h.symbol));
  return [...set].sort();
}

export type FundLogUpdate = { code: string; navAdded: number; distributionsAdded: LoggedDistribution[]; changedUpstream: number; lastNav: string | null; note?: string };

/** Pure merge: add what is new, change nothing that is on file. */
export function mergeFundLog(prev: FundLogEntry | undefined, plain: NavPoint[], dists: FundDistribution[], now: string): { next: FundLogEntry; navAdded: number; distributionsAdded: LoggedDistribution[]; changedUpstream: number } {
  const have = new Map(prev?.nav ?? []);
  let navAdded = 0, changedUpstream = 0;
  for (const p of plain) {
    const on = have.get(p.date);
    if (on == null) {
      have.set(p.date, p.nav);
      navAdded++;
    } else if (Math.abs(on - p.nav) > 0.00005) changedUpstream++;
  }
  const haveDist = new Set((prev?.dists ?? []).map((d) => d.date));
  const distributionsAdded = dists.filter((d) => !haveDist.has(d.date)).map((d) => ({ ...d, at: now }));
  return {
    next: {
      nav: [...have.entries()].sort((a, b) => a[0].localeCompare(b[0])),
      dists: [...(prev?.dists ?? []), ...distributionsAdded].sort((a, b) => a.date.localeCompare(b.date)),
      firstLoggedAt: prev?.firstLoggedAt ?? now,
    },
    navAdded,
    distributionsAdded,
    changedUpstream,
  };
}

/**
 * Bring the log up to date for every fund in the models. Read-merge-write of
 * the one key; an unreadable log is LEFT ALONE (returns an error) rather than
 * replaced. Never throws.
 */
export async function updateFundNavLog(opts: { dryRun?: boolean } = {}): Promise<{ ok: boolean; wrote: boolean; funds: FundLogUpdate[]; error?: string }> {
  try {
    const redis = await getRedis();
    const modelsRaw = await redis.get("pm:pim-models");
    const codes = fundCodesInModels(modelsRaw ? (JSON.parse(modelsRaw) as PimModelData) : null);
    if (!codes.length) return { ok: true, wrote: false, funds: [] };
    let current: FundNavLog | null;
    try {
      current = await readFundNavLog();
    } catch (e) {
      return { ok: false, wrote: false, funds: [], error: e instanceof Error ? e.message : String(e) };
    }
    const now = new Date().toISOString();
    const next: FundNavLog = { funds: { ...(current?.funds ?? {}) }, updatedAt: now };
    const funds: FundLogUpdate[] = [];
    let changed = false;
    await Promise.all(
      codes.map(async (code) => {
        const records = current?.funds?.[code]?.nav?.length ? DAILY_RECORDS : SEED_RECORDS;
        const [plain, adjusted] = await Promise.all([fetchFundNav(code, { records, adjusted: false }), fetchFundNav(code, { records, adjusted: true })]);
        if (!plain.length) {
          funds.push({ code, navAdded: 0, distributionsAdded: [], changedUpstream: 0, lastNav: current?.funds?.[code]?.nav?.at(-1)?.[0] ?? null, note: "the price feed returned nothing" });
          return;
        }
        // No adjusted series → log the NAVs, and say distributions could not be read (never guess "none").
        const m = mergeFundLog(current?.funds?.[code], plain, adjusted.length ? findDistributions(plain, adjusted) : [], now);
        if (m.navAdded || m.distributionsAdded.length) {
          next.funds[code] = m.next;
          changed = true;
        }
        funds.push({ code, navAdded: m.navAdded, distributionsAdded: m.distributionsAdded, changedUpstream: m.changedUpstream, lastNav: m.next.nav.at(-1)?.[0] ?? null, ...(adjusted.length ? {} : { note: "distributions could not be read this run" }) });
      }),
    );
    funds.sort((a, b) => a.code.localeCompare(b.code));
    if (changed && !opts.dryRun) await redis.set(FUND_NAV_LOG_KEY, JSON.stringify(next));
    return { ok: true, wrote: changed && !opts.dryRun, funds };
  } catch (e) {
    log.warn("update failed:", e);
    return { ok: false, wrote: false, funds: [], error: e instanceof Error ? e.message : String(e) };
  }
}

/** A fund's year-to-date total return from OUR log (plain NAVs + logged distributions). */
export function loggedYtd(entry: FundLogEntry): number | null {
  return ytdReturn(totalReturnIndex(entry.nav.map(([date, nav]) => ({ date, nav })), entry.dists));
}
