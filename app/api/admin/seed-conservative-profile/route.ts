import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimModelData, PimProfileWeights } from "@/app/lib/pim-types";

/**
 * One-shot: add a `conservative` profile to the PIM group in the live
 * pm:pim-models blob so the new Conservative model appears in Positioning /
 * PIM Model and starts accruing performance. The asset-allocation split is
 * 30% equity / 64% fixed income / 6% alternatives (the PM can fine-tune it
 * afterward in the AA & Perf tab's Conservative card, which writes back here).
 *
 * Scoped to the PIM group ONLY — Conservative isn't offered on the other
 * mandates (pc-usa, non-res, etc.) for now. Pass ?all=YES to seed every
 * group instead, if that's ever wanted.
 *
 * SAFETY (per CLAUDE.md):
 *   - Requires ?confirm=YES.
 *   - Stashes the pre-image of pm:pim-models to
 *     pm:pre-conservative-seed-stash:<ts> BEFORE mutating. Revert with
 *     redis.set("pm:pim-models", <stash value>).
 *   - Pure read-merge-write: ONLY adds a `conservative` key to each group's
 *     `profiles` object. Holdings, weightInClass, other profiles, cadSplit /
 *     usdSplit — all preserved verbatim. Groups that ALREADY have a
 *     conservative profile are left untouched (idempotent).
 *   - Returns a diff (which groups were seeded vs skipped).
 */

const CONSERVATIVE_WEIGHTS: PimProfileWeights = {
  cash: 0.0,
  fixedIncome: 0.64,
  equity: 0.30,
  alternatives: 0.06,
};

export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("confirm") !== "YES") {
    return NextResponse.json(
      {
        error: "Confirmation required",
        hint: "Append ?confirm=YES to add a conservative profile (30% eq / 64% FI / 6% alt) to every group in pm:pim-models. Idempotent; a pre-image is stashed for rollback. Only adds the profile key — holdings and other profiles are untouched.",
      },
      { status: 400 },
    );
  }
  try {
    const redis = await getRedis();
    const raw = await redis.get("pm:pim-models");
    if (!raw) {
      return NextResponse.json({ ok: false, error: "pm:pim-models missing or empty" }, { status: 500 });
    }
    const models = JSON.parse(raw) as PimModelData;

    // PIM group only by default; ?all=YES seeds every group.
    const allGroups = req.nextUrl.searchParams.get("all") === "YES";

    const seeded: string[] = [];
    const skipped: string[] = [];
    const nextGroups = models.groups.map((g) => {
      const inScope = allGroups || g.id === "pim";
      if (!inScope || g.profiles?.conservative) {
        skipped.push(g.id);
        return g;
      }
      seeded.push(g.id);
      return { ...g, profiles: { ...g.profiles, conservative: { ...CONSERVATIVE_WEIGHTS } } };
    });

    if (seeded.length === 0) {
      return NextResponse.json({
        ok: true,
        seeded: [],
        skipped,
        note: "Every group already has a conservative profile. Nothing to do.",
      });
    }

    // Stash pre-image BEFORE mutating.
    const stamp = new Date().toISOString();
    const stashKey = `pm:pre-conservative-seed-stash:${stamp}`;
    await redis.set(stashKey, raw);

    const next: PimModelData = { ...models, groups: nextGroups, lastUpdated: stamp };
    await redis.set("pm:pim-models", JSON.stringify(next));

    return NextResponse.json({
      ok: true,
      seeded,
      skipped,
      weights: CONSERVATIVE_WEIGHTS,
      stashKey,
      note: `Added conservative profile to ${seeded.length} group(s). Pre-image stashed at ${stashKey}. To revert: redis.set("pm:pim-models", await redis.get("${stashKey}")).`,
    });
  } catch (e) {
    console.error("[seed-conservative-profile] failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
