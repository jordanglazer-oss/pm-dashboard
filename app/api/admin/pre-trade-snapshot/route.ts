/**
 * POST /api/admin/pre-trade-snapshot
 *
 * Writes a fresh frozen snapshot of the four blobs that a trade
 * execution mutates:
 *
 *   pm:pim-models           target holdings + weightInClass per group
 *   pm:pim-positions        actual units + cost basis per group/profile
 *   pm:pim-portfolio-state  transactions + rebalance history
 *   pm:stocks               Portfolio/Watchlist roster (bucket changes on sells)
 *
 * Stored at `pm:pre-trade-snapshot:{ISO timestamp}`. Optional `reason`
 * field on the body is included verbatim in the snapshot payload so
 * later inspection can correlate the snapshot with the action that
 * triggered it (e.g. "executeAllTrades from PimPortfolio").
 *
 * After writing, prunes pre-trade snapshots beyond the last
 * MAX_RETAINED_SNAPSHOTS. The daily backup cron (06/14/22 UTC) is the
 * long-term safety net; these snapshots are specifically for INSTANT
 * "undo the last trade" rollback when something goes wrong mid-session.
 *
 * Idempotent: each call writes a new timestamped key, so calling it
 * twice in a row creates two snapshots. Cheap (~few hundred KB each),
 * fast, and gives an audit trail of every trade attempt.
 *
 * Not gated by ?confirm=YES — it's a READ-then-WRITE-ASIDE; it doesn't
 * touch any user data. The "danger" of calling it is producing an extra
 * snapshot, which the prune logic handles.
 *
 * Security: this lives under /api/admin which IS protected by the
 * auth-cookie middleware, so an unauthenticated caller can't spam it.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

const SNAPSHOT_PREFIX = "pm:pre-trade-snapshot:";
const MAX_RETAINED_SNAPSHOTS = 30;

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

export async function POST(req: NextRequest) {
  let reason = "unspecified";
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body.reason === "string" && body.reason.length > 0 && body.reason.length < 500) {
      reason = body.reason;
    }
  } catch {
    // Body is optional; ignore parse errors.
  }

  try {
    const redis = await getRedis();
    const [pimModels, pimPositions, portfolioState, stocks] = await Promise.all([
      redis.get("pm:pim-models"),
      redis.get("pm:pim-positions"),
      redis.get("pm:pim-portfolio-state"),
      redis.get("pm:stocks"),
    ]);

    const stamp = new Date().toISOString();
    const snapshotKey = `${SNAPSHOT_PREFIX}${stamp}`;
    const payload = {
      snapshotAt: stamp,
      reason,
      // Store raw strings (not parsed) so restoration is byte-identical.
      "pm:pim-models": pimModels,
      "pm:pim-positions": pimPositions,
      "pm:pim-portfolio-state": portfolioState,
      "pm:stocks": stocks,
    };
    await redis.set(snapshotKey, JSON.stringify(payload));

    // Prune oldest beyond MAX_RETAINED_SNAPSHOTS. Snapshot keys sort
    // lexicographically by their ISO timestamp suffix, so a simple
    // string sort gives chronological order.
    const allSnapshotKeys = await scanAll(redis, `${SNAPSHOT_PREFIX}*`);
    let pruned: string[] = [];
    if (allSnapshotKeys.length > MAX_RETAINED_SNAPSHOTS) {
      const sorted = [...allSnapshotKeys].sort(); // oldest first
      const toDelete = sorted.slice(0, sorted.length - MAX_RETAINED_SNAPSHOTS);
      for (const k of toDelete) await redis.del(k);
      pruned = toDelete;
    }

    return NextResponse.json({
      ok: true,
      snapshotKey,
      reason,
      bytes:
        (pimModels?.length ?? 0) +
        (pimPositions?.length ?? 0) +
        (portfolioState?.length ?? 0) +
        (stocks?.length ?? 0),
      retainedCount: Math.min(allSnapshotKeys.length + 1, MAX_RETAINED_SNAPSHOTS),
      pruned,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Snapshot failed" },
      { status: 500 },
    );
  }
}
