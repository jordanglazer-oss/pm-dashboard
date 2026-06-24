/**
 * Shared logic for pruning old pre-operation rollback stashes from Redis.
 *
 * Every risky mutation (rebalance, trade, repair, promote, seed, migration,
 * ticker-rename) writes a pre-image stash so it can be reverted. Once the op
 * is confirmed good those stashes are dead weight — each is a near-full copy
 * of pm:stocks / pm:pim-performance / a PDF blob (1-3 MB) and they accumulate
 * forever. This prunes the ones older than `days`.
 *
 * Used by BOTH the manual /api/admin/prune-stashes endpoint and the nightly
 * backup cron (so Redis self-maintains and never creeps back toward OOM).
 *
 * Matches ONLY stash shapes — never live data:
 *   - pm:pre-*             e.g. pm:pre-promote-stash:<ISO>
 *   - pm:*.pre-*           e.g. pm:pim-performance.pre-anchor-<epochMs>,
 *                               pm:stocks.pre-rename-<dash-ISO>
 *   - the one-off pm:stocks-write-trace diagnostic key
 */

import type { getRedis } from "./redis";

type Redis = Awaited<ReturnType<typeof getRedis>>;

const STASH_MATCHES = ["pm:pre-*", "pm:*.pre-*"];
const EXTRA_KEYS = ["pm:stocks-write-trace"];

/** Parse a timestamp out of a stash key → epoch ms, or null if undateable. */
export function parseStashTimestamp(key: string): number | null {
  // Standard ISO with colons, e.g. 2026-06-20T19:40:03.945Z
  const iso = key.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t)) return t;
  }
  // Dash-mangled ISO from `toISOString().replace(/[:.]/g,"-")`, e.g.
  // 2026-06-21T21-49-49-566Z (the rename / recompute endpoints).
  const dash = key.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/);
  if (dash) {
    const t = Date.parse(`${dash[1]}T${dash[2]}:${dash[3]}:${dash[4]}.${dash[5]}Z`);
    if (Number.isFinite(t)) return t;
  }
  // Date-only ISO, e.g. 2026-06-04 (not followed by a time component).
  const dateOnly = key.match(/(\d{4}-\d{2}-\d{2})(?!T)/);
  if (dateOnly) {
    const t = Date.parse(dateOnly[1]);
    if (Number.isFinite(t)) return t;
  }
  // Trailing 13-digit epoch ms, e.g. .pre-anchor-1778615023510
  const epoch = key.match(/-(\d{13})(?:$|[^0-9])/);
  if (epoch) {
    const t = Number(epoch[1]);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

async function scanAll(redis: Redis, match: string): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

export type StashPruneResult = {
  deleted: string[];
  keptRecent: string[];
  skippedNoDate: string[];
  freedBytes: number;
};

/**
 * Delete stash keys older than `days`. `dryRun` reports what would go without
 * deleting. DEL-only, so it works even when the instance is OOM.
 */
export async function pruneStashes(
  redis: Redis,
  opts: { days: number; dryRun?: boolean },
): Promise<StashPruneResult> {
  const cutoffMs = Date.now() - opts.days * 24 * 60 * 60 * 1000;

  const found = new Set<string>();
  for (const m of STASH_MATCHES) {
    for (const k of await scanAll(redis, m)) found.add(k);
  }
  for (const k of EXTRA_KEYS) {
    if ((await redis.exists(k)) === 1) found.add(k);
  }

  const deleted: string[] = [];
  const keptRecent: string[] = [];
  const skippedNoDate: string[] = [];
  let freedBytes = 0;

  for (const key of found) {
    const isStash = key.startsWith("pm:pre-") || /^pm:.+\.pre-/.test(key);
    const isExtra = EXTRA_KEYS.includes(key);
    if (!isStash && !isExtra) continue;

    const ts = isExtra ? 0 : parseStashTimestamp(key);
    if (ts === null) { skippedNoDate.push(key); continue; }
    if (ts >= cutoffMs && !isExtra) { keptRecent.push(key); continue; }

    const len = await redis.strLen(key).catch(() => 0);
    freedBytes += len;
    if (!opts.dryRun) await redis.del(key);
    deleted.push(key);
  }

  return { deleted, keptRecent, skippedNoDate, freedBytes };
}
