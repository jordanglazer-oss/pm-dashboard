/**
 * POST /api/admin/migrate-pim-baseline-to-redis?confirm=YES
 *
 * One-shot migration: copies the in-repo `pimModelSeed` from pim-seed.ts
 * into Redis under `pm:pim-model-baseline`, so the rebalance math no
 * longer depends on a code-shipped constant. After this runs, the
 * baseline lives in Redis and is editable via PUT /api/kv/pim-model-baseline
 * (or future UI surfaces). pim-seed.ts remains as a last-resort fallback.
 *
 * Stashes any prior value of pm:pim-model-baseline to
 * pm:pre-baseline-migration-stash:{ts} as the first write. Idempotent in
 * the sense that re-running just overwrites with the same content (and
 * stashes the previous identical value); use `?force=YES` to overwrite
 * an existing non-null baseline (otherwise returns 409 to prevent
 * accidental clobbering of user edits).
 *
 * GUARDED: requires ?confirm=YES.
 */

import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { pimModelSeed } from "@/app/lib/pim-seed";

const BASELINE_KEY = "pm:pim-model-baseline";

export async function POST(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  if (searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      { error: "Add ?confirm=YES to actually migrate. This endpoint writes to Redis." },
      { status: 400 },
    );
  }
  const force = searchParams.get("force") === "YES";

  try {
    const redis = await getRedis();
    const existing = await redis.get(BASELINE_KEY);

    if (existing && !force) {
      return NextResponse.json(
        {
          error:
            "pm:pim-model-baseline already exists. To overwrite, add &force=YES (the prior value will be stashed).",
          existingPreview: JSON.parse(existing),
        },
        { status: 409 },
      );
    }

    const stashTs = new Date().toISOString();
    const stashKey = `pm:pre-baseline-migration-stash:${stashTs}`;
    await redis.set(
      stashKey,
      JSON.stringify({
        stashedAt: stashTs,
        reason: "migrate-pim-baseline-to-redis",
        previous: existing ? JSON.parse(existing) : null,
      }),
    );

    const payload = {
      groups: pimModelSeed,
      migratedAt: stashTs,
      source: "pim-seed.ts",
    };
    await redis.set(BASELINE_KEY, JSON.stringify(payload));

    return NextResponse.json({
      ok: true,
      status: existing ? "overwritten" : "created",
      stashKey,
      groupCount: pimModelSeed.length,
      holdingCount: pimModelSeed.reduce((n, g) => n + g.holdings.length, 0),
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Migration failed" },
      { status: 500 },
    );
  }
}
