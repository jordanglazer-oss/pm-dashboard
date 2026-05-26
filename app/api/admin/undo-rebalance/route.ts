/**
 * POST /api/admin/undo-rebalance?stashKey=<key>&confirm=YES
 *
 * Restores pm:pim-models from a stash created by
 * /api/admin/rebalance-pim-models-post-repair.
 *
 * The stash key looks like: pm:pre-rebalance-stash:2026-05-26T...Z
 * It contains the raw pm:pim-models blob verbatim as a JSON string.
 *
 * Before restoring, the CURRENT pm:pim-models is stashed to
 *   pm:pre-undo-rebalance-stash:{ISO timestamp}
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
  if (!stashKey || !stashKey.startsWith("pm:pre-rebalance-stash:")) {
    return NextResponse.json(
      { error: "Pass stashKey=pm:pre-rebalance-stash:... in the query string." },
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
      "pm:pim-models"?: string;
      stashedAt?: string;
      reason?: string;
    };
    const pimRaw = stash["pm:pim-models"];
    if (!pimRaw) {
      return NextResponse.json(
        { error: "stash missing pm:pim-models content" },
        { status: 500 },
      );
    }

    // Stash CURRENT value before overwrite — undo-of-undo support.
    const ts = new Date().toISOString();
    const preUndoKey = `pm:pre-undo-rebalance-stash:${ts}`;
    const current = await redis.get("pm:pim-models");
    await redis.set(
      preUndoKey,
      JSON.stringify({
        stashedAt: ts,
        reason: "undo-rebalance",
        undoOfStash: stashKey,
        "pm:pim-models": current,
      }),
    );

    await redis.set("pm:pim-models", pimRaw);

    return NextResponse.json({
      ok: true,
      restoredFrom: stashKey,
      preUndoStashKey: preUndoKey,
      stashedAt: stash.stashedAt,
      reason: stash.reason,
      note:
        "Restored pm:pim-models from stash. The CURRENT (now-overwritten) value " +
        "has been stashed to preUndoStashKey above, so this undo is also reversible.",
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Undo failed" },
      { status: 500 },
    );
  }
}
