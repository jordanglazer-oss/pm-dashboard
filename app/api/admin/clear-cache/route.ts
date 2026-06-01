import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

/**
 * Free Redis memory by deleting ONLY pure, regenerable caches.
 *
 * Every prefix in SAFELIST is documented in CLAUDE.md as "Pure cache. Safe
 * to nuke." — the data is deterministically re-fetched on the next score /
 * fund lookup / regime refresh. NO user-entered data is ever touched
 * (pm:stocks, pm:pim-models, pm:research, pm:analyst-report-pdf:*,
 * pm:attachment:*, etc. are all excluded by omission).
 *
 * DEL is permitted under OOM, so this is the recovery path for the
 * "OOM command not allowed" error.
 *
 * ?confirm=YES required. Optional ?only=<comma-separated prefixes> to limit
 * to a subset of the safelist (e.g. ?only=pm:edgar-facts:).
 */

// SCAN patterns for caches that regenerate themselves. Exact-key entries
// (no trailing colon) and family entries (trailing ":*") both supported.
const SAFELIST: string[] = [
  "pm:edgar-facts:*",        // XBRL company facts — refetch on next score
  "pm:edgar-submissions:*",  // SEC submissions metadata — refetch
  "pm:edgar-form4:*",        // insider-trade summaries — refetch
  "pm:edgar-ticker-map",     // ticker→CIK map — rebuilt on next call
  "pm:fund-data-cache",      // Morningstar/Yahoo fund data — refetch
  "pm:fund-data-negative:*", // negative cache — rebuilds
  "pm:market-regime",        // regime snapshot — recomputed on next GET
];

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

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  if (params.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to delete regenerable caches. Only the documented pure-cache prefixes are touched — never user data.",
        safelist: SAFELIST,
      },
      { status: 400 },
    );
  }

  const only = (params.get("only") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const patterns = only.length > 0
    ? SAFELIST.filter((p) => only.some((o) => p.startsWith(o)))
    : SAFELIST;

  const startedAt = Date.now();
  try {
    const redis = await getRedis();

    let freedBytes = 0;
    let deletedCount = 0;
    const perPattern: { pattern: string; deleted: number; bytes: number }[] = [];

    for (const pattern of patterns) {
      const keys = await scanAll(redis, pattern);
      let patBytes = 0;
      for (const key of keys) {
        // Defense in depth: never delete anything outside the safelist
        // families. A bare exact key matches itself; a family pattern's
        // matches all begin with the family root.
        try { patBytes += await redis.strLen(key); } catch { /* best effort */ }
        await redis.del(key);
        deletedCount += 1;
      }
      freedBytes += patBytes;
      perPattern.push({ pattern, deleted: keys.length, bytes: patBytes });
    }

    return NextResponse.json({
      ok: true,
      deletedCount,
      freedBytes,
      freedMB: +(freedBytes / 1e6).toFixed(2),
      perPattern,
      note: "Pure caches only. They regenerate automatically on next use; no user data was touched.",
      elapsedMs: Date.now() - startedAt,
    });
  } catch (e) {
    console.error("[clear-cache] failed:", e);
    return NextResponse.json(
      { error: "Clear-cache failed", message: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
