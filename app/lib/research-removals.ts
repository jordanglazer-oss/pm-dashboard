/**
 * Research-list removal log — an APPEND-ONLY record of tickers dropped from a
 * research list (Fundstrat / RBC / JPM / Alpha Picks / FEW / Newton Upticks)
 * when a fresh screenshot or emailed list REPLACES the old one. Screenshot
 * ingestion runs in replace mode, so a name no longer in the upstream list is
 * silently removed from pm:research — this log preserves that fact so the
 * Dashboard Change Monitor can surface "dropped from <list>" events.
 *
 * Storage: Redis key `pm:research-removals`, shape { [YYYY-MM-DD]: Entry[] }.
 * Follows the append-only invariant used by pm:portfolio-snapshots: the server
 * always buckets under TODAY (server-stamped `at`), so past-dated writes are
 * impossible by construction. Dedupe is per (ticker, source) within a day so a
 * re-upload of the same screenshot doesn't stack duplicate events. Pure cache
 * of an event stream — safe to nuke (worst case: the Change Monitor loses
 * historical removal events; nothing user-authored is lost).
 */

import type { getRedis } from "./redis";
import type { SourceKey } from "@/app/api/research-scrape/route";

/** A research source that can shed tickers. Superset of the scrape SourceKey
 *  plus Newton Upticks (which merges on the client, outside applyResearchEntries). */
export type RemovalSource = SourceKey | "newton-upticks";

export type ResearchRemovalEntry = {
  ticker: string;
  source: RemovalSource;
  /** Human label for the source, snapshotted at write time. */
  sourceLabel: string;
  /** ISO timestamp, server-stamped. */
  at: string;
};

export type ResearchRemovalStore = { [date: string]: ResearchRemovalEntry[] };

export const REMOVAL_SOURCE_LABELS: Record<RemovalSource, string> = {
  "fundstrat-top": "Fundstrat Top",
  "fundstrat-bottom": "Fundstrat Bottom",
  "fundstrat-smid-top": "Fundstrat SMID Top",
  "fundstrat-smid-bottom": "Fundstrat SMID Bottom",
  "fundstrat-largecap-core": "Fundstrat Large-Cap Core",
  "fundstrat-smid-core": "Fundstrat SMID Core",
  "rbc-focus": "RBC Canadian Focus",
  "rbc-us-focus": "RBC US Focus",
  "jpm-us-analyst-focus": "JPM US Analyst Focus",
  "rbc-equate-cad": "RBC Equate CAD (CORE 40)",
  "rbc-equate-usd": "RBC Equate USD (CORE 40)",
  "seeking-alpha-picks": "Seeking Alpha — Alpha Picks",
  "rbccm-few": "RBCCM FEW",
  "newton-upticks": "Newton Upticks",
};

export const RESEARCH_REMOVALS_KEY = "pm:research-removals";

/** Days of history to retain. Older day-buckets are pruned on each write. */
export const REMOVAL_RETENTION_DAYS = 45;

/** Pure append: bucket new entries under `today`, deduped per (ticker, source),
 *  then prune day-keys older than the retention window. Returns the next store
 *  and how many entries were actually added. */
export function appendRemovals(
  store: ResearchRemovalStore,
  incoming: Array<{ ticker: string; source: RemovalSource; sourceLabel?: string }>,
  today: string,
  nowIso: string,
): { store: ResearchRemovalStore; added: number } {
  const next: ResearchRemovalStore = { ...store };
  const dayList = next[today] ? [...next[today]] : [];
  const seen = new Set(dayList.map((e) => `${e.ticker}|${e.source}`));
  let added = 0;
  for (const r of incoming) {
    const ticker = String(r?.ticker || "").toUpperCase().trim();
    const source = r?.source;
    if (!ticker || !source) continue;
    const dk = `${ticker}|${source}`;
    if (seen.has(dk)) continue;
    seen.add(dk);
    dayList.push({ ticker, source, sourceLabel: r.sourceLabel || REMOVAL_SOURCE_LABELS[source] || source, at: nowIso });
    added += 1;
  }
  next[today] = dayList;

  // Prune old day-buckets beyond retention.
  const cutoffMs = Date.parse(`${today}T00:00:00Z`) - REMOVAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const d of Object.keys(next)) {
    const dMs = Date.parse(`${d}T00:00:00Z`);
    if (Number.isFinite(dMs) && dMs < cutoffMs) delete next[d];
  }
  return { store: next, added };
}

/** Server-side helper: read the removal log, append tickers dropped from a
 *  source, and write it back. Best-effort — never throws into the caller (a
 *  logging failure must not break the merge that triggered it). */
export async function logResearchRemovals(
  redis: Awaited<ReturnType<typeof getRedis>>,
  removedTickers: string[],
  source: RemovalSource,
): Promise<void> {
  if (!removedTickers || removedTickers.length === 0) return;
  try {
    const raw = await redis.get(RESEARCH_REMOVALS_KEY);
    const store: ResearchRemovalStore = raw ? JSON.parse(raw) : {};
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const nowIso = now.toISOString();
    const { store: nextStore } = appendRemovals(
      store,
      removedTickers.map((t) => ({ ticker: t, source })),
      today,
      nowIso,
    );
    await redis.set(RESEARCH_REMOVALS_KEY, JSON.stringify(nextStore));
  } catch {
    /* best-effort: removal logging must never break the merge */
  }
}
