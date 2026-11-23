import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { fetchLivePriceSnapshot } from "@/app/lib/live-prices";
import { rankResearch } from "@/app/lib/research-ranked";
import { RANKED_HISTORY_KEY, etDay, trackingFor, type RankedHistory } from "@/app/lib/ranked-source-history";
import { watchAlerts, watchRows, type WatchAlert, type WatchStockLike } from "@/app/lib/watchlist-plan";
import type { ResearchState } from "@/app/lib/defaults";
import { listFlags, raiseFlag } from "./flags";
import { readAgentSettings, isWatcherOn } from "./settings";

/**
 * Watchlist alerts (Nov 2026, meeting item 8) — plain rules, no model call:
 *   - a watchlist name trades AT OR BELOW its target buy price (medium), and
 *   - a watchlist name newly joins research lists and now sits on 2+ (low).
 * One flag per name per rule per month: a finding whose dedupeKey is already
 * on file in ANY status is not raised again. Flags go out through the usual
 * flag emails (end-of-day email; nothing here is "high").
 *
 * Reads pm:stocks, pm:research and pm:ranked-source-history READ-ONLY and
 * fetches live prices (only for names that have a target). Writes only flags.
 * Never throws.
 */

const log = createLogger("Watchlist-alerts");
const WATCHER = "watchlist-watch";

export type WatchlistAlertResult = { ok: boolean; skipped?: string; error?: string; date: string; watchlist: number; withTarget: number; alerts: WatchAlert[]; raised: string[]; alreadyOnFile: string[] };

const parse = <T,>(raw: string | null, fallback: T): T => {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
};

async function findAlerts(): Promise<{ date: string; watchlist: number; withTarget: number; alerts: WatchAlert[] }> {
  const redis = await getRedis();
  const [stocksRaw, researchRaw, historyRaw] = await Promise.all([redis.get("pm:stocks"), redis.get("pm:research"), redis.get(RANKED_HISTORY_KEY)]);
  const parsed = parse<unknown>(stocksRaw, []);
  const stocks = (Array.isArray(parsed) ? parsed : []) as WatchStockLike[];
  const watch = stocks.filter((s) => s.bucket === "Watchlist");
  const withTarget = watch.filter((s) => typeof s.watch?.targetBuyPrice === "number" && s.watch.targetBuyPrice > 0);
  const today = etDay();

  const prices: Record<string, number | null> = {};
  for (let i = 0; i < withTarget.length; i += 50) Object.assign(prices, (await fetchLivePriceSnapshot(withTarget.slice(i, i + 50).map((s) => s.ticker))).prices);

  // Watchlist names that joined bullish lists in the last week (from the first-appearance log).
  const history = parse<RankedHistory | null>(historyRaw, null);
  const newOnLists: Record<string, { count: number; joined: string[] }> = {};
  if (history?.tickers) {
    for (const row of rankResearch(parse<Partial<ResearchState>>(researchRaw, {}), stocks.map((s) => ({ ticker: s.ticker, bucket: s.bucket, name: s.name })))) {
      if (row.held !== "Watchlist" || !row.heldTicker) continue;
      const tr = trackingFor(history, row, today);
      if (tr.newOn.length) newOnLists[row.heldTicker] = { count: row.listCount, joined: row.lists.filter((l) => tr.newOn.includes(l.key)).map((l) => l.label) };
    }
  }
  return { date: today, watchlist: watch.length, withTarget: withTarget.length, alerts: watchAlerts(watchRows(stocks, prices), newOnLists, today.slice(0, 7)) };
}

/** What the rules find right now. Read-only — raises nothing. */
export async function previewWatchlistAlerts(): Promise<WatchlistAlertResult> {
  const found = await findAlerts();
  const flags = await listFlags();
  return { ok: true, ...found, raised: [], alreadyOnFile: found.alerts.filter((a) => flags.some((f) => f.dedupeKey === a.dedupeKey)).map((a) => a.dedupeKey) };
}

/** Run the rules and raise each NEW finding as a flag. */
export async function runWatchlistAlerts(): Promise<WatchlistAlertResult> {
  const base: WatchlistAlertResult = { ok: false, date: etDay(), watchlist: 0, withTarget: 0, alerts: [], raised: [], alreadyOnFile: [] };
  try {
    if (!isWatcherOn(WATCHER, await readAgentSettings())) return { ...base, ok: true, skipped: "switched off" };
    const found = await findAlerts();
    const flags = await listFlags();
    const raised: string[] = [];
    const alreadyOnFile: string[] = [];
    for (const a of found.alerts) {
      if (flags.some((f) => f.dedupeKey === a.dedupeKey)) {
        alreadyOnFile.push(a.dedupeKey);
        continue;
      }
      const flag = await raiseFlag({ watcher: WATCHER, priority: a.priority, ticker: a.ticker, title: a.title, detail: a.detail, suggestion: a.suggestion, dedupeKey: a.dedupeKey, evidence: [{ label: `Rule: ${a.rule}` }] });
      raised.push(flag.id);
    }
    return { ok: true, ...found, raised, alreadyOnFile };
  } catch (e) {
    log.error("failed:", e);
    return { ...base, error: e instanceof Error ? e.message : String(e) };
  }
}
