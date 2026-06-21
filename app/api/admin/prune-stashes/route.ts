import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Free Redis memory by deleting old pre-operation rollback stashes.
 *
 * Every risky mutation (rebalance, trade, repair, promote, conservative
 * seed, migrations) writes a pre-image stash so it can be reverted. Once
 * the operation is confirmed good, those stashes are dead weight — and they
 * accumulate (each is a near-full copy of pm:stocks / pm:pim-performance /
 * etc., ~1-3 MB). This endpoint deletes the ones older than ?days (default
 * 14), keeping recent stashes available for rollback.
 *
 * Matches ONLY these stash shapes (never touches live data):
 *   - pm:pre-*            e.g. pm:pre-promote-stash:<ISO>, pm:pre-trade-snapshot:<ISO>
 *   - pm:*.pre-*          e.g. pm:pim-performance.pre-anchor-<epochMs>
 *   - pm:stocks-write-trace  (the AVGO/ORCL diagnostic tracer — one-off)
 *
 * Age is parsed from an ISO timestamp or a trailing 13-digit epoch-ms in
 * the key. Keys whose age can't be determined are SKIPPED (never deleted).
 *
 * SAFETY:
 *   - ?confirm=YES required.
 *   - DEL only — works even when the instance is OOM.
 *   - Hard guard: a key must match one of the stash patterns AND parse to a
 *     date older than the cutoff before it's deleted.
 *   - Returns deleted / kept / skipped lists + bytes freed.
 */

const STASH_MATCHES = ["pm:pre-*", "pm:*.pre-*"];
// Extra one-off diagnostic keys safe to drop with the stashes.
const EXTRA_KEYS = ["pm:stocks-write-trace"];

async function scanAll(
  redis: Awaited<ReturnType<typeof getRedis>>,
  match: string,
): Promise<string[]> {
  const keys: string[] = [];
  for await (const key of redis.scanIterator({ MATCH: match, COUNT: 200 })) {
    if (Array.isArray(key)) keys.push(...key);
    else keys.push(key);
  }
  return keys;
}

/** Parse a timestamp out of a stash key. Returns epoch ms or null. */
function parseKeyTimestamp(key: string): number | null {
  // ISO form anywhere in the key, e.g. 2026-06-20T19:40:03.945Z
  const iso = key.match(/(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)/);
  if (iso) {
    const t = Date.parse(iso[1]);
    if (Number.isFinite(t)) return t;
  }
  // Date-only ISO, e.g. 2026-06-04
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

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to delete pre-operation rollback stashes older than ?days (default 14). Only pm:pre-*, pm:*.pre-*, and the one-off pm:stocks-write-trace are ever touched; live data is never matched. Pass ?dryRun=YES to preview without deleting.",
      },
      { status: 400 },
    );
  }
  const dryRun = params.get("dryRun") === "YES";
  const daysRaw = parseInt(params.get("days") ?? "14", 10);
  const days = Number.isFinite(daysRaw) && daysRaw >= 0 ? daysRaw : 14;
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;

  try {
    const redis = await getRedis();

    // Collect candidate keys from the stash patterns + extras.
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
      // Belt-and-suspenders: only act on stash-shaped or extra keys.
      const isStash = key.startsWith("pm:pre-") || /^pm:.+\.pre-/.test(key);
      const isExtra = EXTRA_KEYS.includes(key);
      if (!isStash && !isExtra) continue;

      // Extras have no timestamp — treat as always-eligible.
      const ts = isExtra ? 0 : parseKeyTimestamp(key);
      if (ts === null) { skippedNoDate.push(key); continue; }
      if (ts >= cutoffMs && !isExtra) { keptRecent.push(key); continue; }

      const len = await redis.strLen(key).catch(() => 0);
      freedBytes += len;
      if (!dryRun) await redis.del(key);
      deleted.push(key);
    }

    return NextResponse.json({
      ok: true,
      dryRun,
      olderThanDays: days,
      deletedCount: deleted.length,
      deleted,
      keptRecent,
      skippedNoDate,
      freedBytes,
      freedMB: Math.round((freedBytes / 1048576) * 100) / 100,
      note: dryRun
        ? "Dry run — nothing deleted. Re-run without &dryRun=YES to apply."
        : `Deleted ${deleted.length} stash key(s), freed ${Math.round((freedBytes / 1048576) * 100) / 100} MB.`,
    });
  } catch (e) {
    console.error("[prune-stashes] failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
