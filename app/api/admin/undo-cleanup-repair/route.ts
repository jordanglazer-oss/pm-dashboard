/**
 * POST /api/admin/undo-cleanup-repair?stashKey=<key>&confirm=YES
 *
 * Restores pm:stocks and pm:pim-models from a stash created by
 * /api/admin/repair-multi-trade-202605-cleanup.
 *
 * The stash key looks like: pm:pre-repair-stash:2026-05-25T...Z
 * It contains both raw blobs verbatim as JSON strings — restoring
 * just calls redis.set with those strings.
 *
 * Before restoring, the CURRENT blobs are stashed to
 *   pm:pre-undo-stash:{ISO timestamp}
 * so the undo is itself reversible.
 *
 * GUARDED: requires both ?stashKey=... AND ?confirm=YES.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      { error: "Add ?confirm=YES to actually run the undo." },
      { status: 400 },
    );
  }
  const stashKey = searchParams.get("stashKey");
  if (!stashKey || !stashKey.startsWith("pm:pre-repair-stash:")) {
    return NextResponse.json(
      { error: "Pass stashKey=pm:pre-repair-stash:... in the query string." },
      { status: 400 },
    );
  }

  try {
    const redis = await getRedis();
    const raw = await redis.get(stashKey);
    if (!raw) {
      return NextResponse.json({ error: `stash ${stashKey} not found` }, { status: 404 });
    }
    const stash = JSON.parse(raw) as {
      "pm:stocks"?: string;
      "pm:pim-models"?: string;
      stashedAt?: string;
      reason?: string;
    };
    const stocksRaw = stash["pm:stocks"];
    const pimRaw = stash["pm:pim-models"];
    if (!stocksRaw || !pimRaw) {
      return NextResponse.json(
        { error: "stash missing pm:stocks or pm:pim-models content" },
        { status: 500 },
      );
    }

    // Stash CURRENT values before overwrite so an undo-of-undo is possible.
    const ts = new Date().toISOString();
    const preUndoKey = `pm:pre-undo-stash:${ts}`;
    const [currentStocks, currentPim] = await Promise.all([
      redis.get("pm:stocks"),
      redis.get("pm:pim-models"),
    ]);
    await redis.set(
      preUndoKey,
      JSON.stringify({
        stashedAt: ts,
        reason: "undo-cleanup-repair",
        undoOfStash: stashKey,
        "pm:stocks": currentStocks,
        "pm:pim-models": currentPim,
      }),
    );

    // Replay the stashed raw strings.
    await redis.set("pm:stocks", stocksRaw);
    await redis.set("pm:pim-models", pimRaw);

    return NextResponse.json({
      ok: true,
      restoredFrom: stashKey,
      preUndoStashKey: preUndoKey,
      stashedAt: stash.stashedAt,
      reason: stash.reason,
      note:
        "Restored pm:stocks and pm:pim-models from stash. The CURRENT (now-overwritten) " +
        "values have themselves been stashed to preUndoStashKey above, so this undo is " +
        "also reversible.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Undo failed" },
      { status: 500 },
    );
  }
}
