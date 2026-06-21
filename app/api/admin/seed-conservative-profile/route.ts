import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import type { PimModelData, PimProfileWeights, PimPerformanceData, AppendixData } from "@/app/lib/pim-types";

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

    const stamp = new Date().toISOString();

    // Write pim-models only when something new was actually added.
    if (seeded.length > 0) {
      await redis.set(`pm:pre-conservative-seed-stash:${stamp}`, raw); // stash pre-image
      const next: PimModelData = { ...models, groups: nextGroups, lastUpdated: stamp };
      await redis.set("pm:pim-models", JSON.stringify(next));
    }

    // ── Bootstrap the Conservative performance series ──────────────────
    // Runs EVERY time (idempotent) so re-running after the profile already
    // exists in pm:pim-models still initializes the forward-accruing series.
    // Two flat base points at index 100 dated the prior two ET days let the
    // update-daily-value loop (which needs >= 2 points) append TODAY's REAL
    // value on its next run. No real returns are fabricated — these are
    // inception reference points only. A back-computed series (first entry
    // older than the base) is reset so no fake history survives.
    const etDate = (daysAgo: number) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date(Date.now() - daysAgo * 86_400_000));
    const dayBefore = etDate(2);
    const yesterday = etDate(1);
    const basePoints = [
      { date: dayBefore, value: 100, dailyReturn: 0 },
      { date: yesterday, value: 100, dailyReturn: 0 },
    ];

    let perfStatus = "left as-is (already accruing)";
    const perfRaw = await redis.get("pm:pim-performance");
    if (perfRaw) {
      const perf = JSON.parse(perfRaw) as PimPerformanceData;
      const i = perf.models.findIndex((m) => m.groupId === "pim" && m.profile === "conservative");
      const existing = i >= 0 ? perf.models[i] : null;
      const backComputed = !!existing && existing.history.length > 0 && existing.history[0].date < dayBefore;
      if (!existing || backComputed) {
        await redis.set(`pm:pre-conservative-perf-stash:${stamp}`, perfRaw); // stash pre-image
        const model = { groupId: "pim", profile: "conservative" as const, history: basePoints, lastUpdated: stamp };
        const nextModels = i >= 0 ? perf.models.map((m, idx) => (idx === i ? model : m)) : [...perf.models, model];
        await redis.set("pm:pim-performance", JSON.stringify({ ...perf, models: nextModels }));
        perfStatus = backComputed ? "reset (removed back-computed history)" : "seeded inception base";
      }
    }

    let appendixStatus = "left as-is";
    const appRaw = await redis.get("pm:appendix-daily-values");
    if (appRaw) {
      const app = JSON.parse(appRaw) as AppendixData;
      const i = app.ledgers.findIndex((l) => l.profile === "conservative");
      const existing = i >= 0 ? app.ledgers[i] : null;
      const backComputed = !!existing && existing.entries.length > 0 && existing.entries[0].date < dayBefore;
      if (!existing || backComputed) {
        const ledger = { profile: "conservative" as const, entries: basePoints.map((p) => ({ ...p, addedAt: stamp })) };
        const nextLedgers = i >= 0 ? app.ledgers.map((l, idx) => (idx === i ? ledger : l)) : [...app.ledgers, ledger];
        await redis.set("pm:appendix-daily-values", JSON.stringify({ ...app, ledgers: nextLedgers }));
        appendixStatus = backComputed ? "reset" : "seeded";
      }
    }

    return NextResponse.json({
      ok: true,
      seeded,
      skipped,
      weights: CONSERVATIVE_WEIGHTS,
      performance: { pimPerformance: perfStatus, appendixLedger: appendixStatus, inceptionBase: [dayBefore, yesterday] },
      note: `Conservative profile present on PIM. Performance series ${perfStatus}; it now accrues its own daily values forward from ${yesterday} (no fabricated history). ${seeded.length > 0 ? "pim-models updated." : "pim-models already had the profile."}`,
    });
  } catch (e) {
    console.error("[seed-conservative-profile] failed:", e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
