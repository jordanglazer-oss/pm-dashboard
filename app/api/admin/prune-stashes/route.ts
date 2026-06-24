import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { pruneStashes } from "@/app/lib/stash-prune";

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

  try {
    const redis = await getRedis();
    const { deleted, keptRecent, skippedNoDate, freedBytes } = await pruneStashes(redis, { days, dryRun });

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
