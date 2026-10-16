import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { snapshotModels, diffModels } from "@/app/lib/model-versions";
import { readDraftStore } from "@/app/lib/model-drafts-store";
import { MODEL_DRAFTS_KEY, draftHasBuckets, sameSymbol, stagedBucket, validateHoldings, withPins, type StagingStock } from "@/app/lib/model-staging";
import type { EquityBucket } from "@/app/lib/pim-types";
import type { PimModelData, PimPerformanceData } from "@/app/lib/pim-types";

/**
 * POST /api/model-staging/apply — write the active staged draft into pm:pim-models.
 * Body: { draftId, expectedRevision, confirm: "APPLY", groupIds?: string[] }
 *
 * In order, stopping at the first failure:
 *   1. `confirm` must be exactly "APPLY"; the draft must be the active one;
 *   2. the live revision must equal `expectedRevision` — the revision the PM
 *      reviewed the diff against. Anything else (a trade, a Review commit,
 *      another tab) → 409 and nothing is written;
 *   3. every staged model must validate (each class sums to 100%, no dupes);
 *   4. pm:pim-models is snapshotted (pm:pim-models-version:<id>) — the undo,
 *      restorable from the Review page's version history;
 *   5. each staged group's `holdings` is replaced (every other group field and
 *      every un-staged group pass through untouched); stocks staged off the
 *      per-stock rule weight are pinned; revision is bumped;
 *   6. the draft moves to history with the version id + the symbols each
 *      model exited (Positioning's Rebalance sells exactly those to zero).
 *   Three-bucket drafts (rows carry a Core / Thematic / Alpha bucket) also
 *   write `sleeveTargets` (the source model's bucket shares, from now on)
 *   and return `roles` — the bucket of every source equity name — which the
 *   client writes to pm:stocks through its normal path (this route never
 *   writes pm:stocks: the client persists that array whole, so a server write
 *   would be overwritten by the next client save).
 * Returns the per-holding diff.
 *
 * Touches pm:pim-models (read-modify-write), pm:model-drafts, and the version
 * keys. Never pm:stocks or pm:pim-positions.
 */

const log = createLogger("Model-staging-apply");
const HISTORY_MAX = 12;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => ({}))) as { draftId?: string; expectedRevision?: number; confirm?: string; groupIds?: string[] };
    if (body.confirm !== "APPLY") return NextResponse.json({ error: "type APPLY to confirm" }, { status: 400 });

    const store = await readDraftStore();
    const draft = store.active;
    if (!draft || draft.id !== body.draftId) return NextResponse.json({ error: "that draft is not the active one" }, { status: 404 });

    const redis = await getRedis();
    const [pimRaw, stocksRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks")]);
    if (!pimRaw) return NextResponse.json({ error: "no models on file" }, { status: 500 });
    const models = JSON.parse(pimRaw) as PimModelData;
    const liveRev = models.revision ?? 0;
    if (typeof body.expectedRevision !== "number" || body.expectedRevision !== liveRev) {
      return NextResponse.json({ error: "the live models changed since you reviewed this draft — review the diff again", revision: liveRev }, { status: 409 });
    }
    const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as StagingStock[];

    const wanted = Array.isArray(body.groupIds) && body.groupIds.length ? new Set(body.groupIds) : null;
    const staged = Object.entries(draft.models).filter(([gid]) => (!wanted || wanted.has(gid)) && models.groups.some((g) => g.id === gid));
    if (staged.length === 0) return NextResponse.json({ error: "nothing staged for any live model" }, { status: 400 });

    const problems: string[] = [];
    for (const [gid, m] of staged) {
      const name = models.groups.find((g) => g.id === gid)?.name ?? gid;
      for (const e of validateHoldings(m.holdings)) problems.push(`${name}: ${e}`);
    }
    if (problems.length) return NextResponse.json({ error: "draft does not validate — nothing written", problems }, { status: 409 });

    const versionId = await snapshotModels("manual", `before staged model apply "${draft.name}" (${staged.length} models)`);
    if (!versionId) return NextResponse.json({ error: "could not snapshot the current models — nothing written" }, { status: 500 });

    const at = new Date().toISOString();
    const month = at.slice(0, 7);
    const exits: Record<string, string[]> = {};
    const nextGroups = models.groups.map((g) => {
      const m = draft.models[g.id];
      if (!m || (wanted && !wanted.has(g.id))) return g;
      exits[g.id] = g.holdings.filter((h) => !m.holdings.some((s) => sameSymbol(s.symbol, h.symbol))).map((h) => h.symbol);
      return { ...g, holdings: withPins(m.holdings, stocks, month, at, draft.parsed) };
    });
    // Three-bucket drafts: the source model's bucket shares become the targets.
    let sleeveTargets: PimModelData["sleeveTargets"] = models.sleeveTargets;
    const roles: Record<string, EquityBucket> = {};
    const src = draft.models[draft.sourceGroupId];
    if (draftHasBuckets(draft.parsed) && src && (!wanted || wanted.has(draft.sourceGroupId))) {
      const t = { core: 0, thematic: 0, alpha: 0 };
      for (const h of src.holdings) {
        if (h.assetClass !== "equity") continue;
        const b = stagedBucket(h.symbol, stocks, draft.parsed);
        t[b] += h.weightInClass;
        roles[h.symbol] = b;
      }
      const r6 = (v: number) => parseFloat(v.toFixed(6));
      sleeveTargets = { core: r6(t.core), thematic: r6(t.thematic), alpha: r6(t.alpha), since: at };
    }
    const nextModels: PimModelData = { ...models, groups: nextGroups, revision: liveRev + 1, lastUpdated: at, ...(sleeveTargets ? { sleeveTargets } : {}) };
    await redis.set("pm:pim-models", JSON.stringify(nextModels));

    // Draft → history (read-merge-write on a fresh read; other fields kept).
    try {
      const fresh = await readDraftStore();
      const applied = { ...draft, status: "applied" as const, appliedAt: at, versionId, exits, ...(Object.keys(roles).length && sleeveTargets ? { sleeveTargets: { core: sleeveTargets.core, thematic: sleeveTargets.thematic, alpha: sleeveTargets.alpha } } : {}) };
      await redis.set(
        MODEL_DRAFTS_KEY,
        JSON.stringify({
          ...fresh,
          active: fresh.active?.id === draft.id ? null : fresh.active,
          history: [applied, ...fresh.history.filter((h) => h.id !== draft.id)].slice(0, HISTORY_MAX),
        }),
      );
    } catch (e) {
      log.warn("draft history write failed (models already applied):", e);
    }

    // First three-bucket apply: start the firm-wide Thematic series at an
    // inception base of 100 (no fabricated history — same as the Conservative
    // seed). /api/update-daily-value then accrues it daily; the Alpha series
    // stops counting Thematic funds from the day they are tagged. Read-merge-
    // write appending ONE model, pre-image stashed; never touches existing series.
    let thematicSeries = "not needed";
    if (Object.keys(roles).length) {
      try {
        const perfRaw = await redis.get("pm:pim-performance");
        if (perfRaw) {
          const perf = JSON.parse(perfRaw) as PimPerformanceData;
          if (!perf.models.some((m) => m.groupId === "pim" && m.profile === "thematic")) {
            const etDate = (daysAgo: number) =>
              new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" })
                .format(new Date(Date.now() - daysAgo * 86_400_000));
            await redis.set(`pm:pim-performance.pre-thematic-seed-${Date.now()}`, perfRaw);
            const model = {
              groupId: "pim",
              profile: "thematic" as const,
              history: [
                { date: etDate(2), value: 100, dailyReturn: 0 },
                { date: etDate(1), value: 100, dailyReturn: 0 },
              ],
              lastUpdated: at,
            };
            await redis.set("pm:pim-performance", JSON.stringify({ ...perf, models: [...perf.models, model] }));
            thematicSeries = `seeded at 100 from ${etDate(1)}`;
            // Matching Appendix ledger (the Performance tile re-seeds a group's
            // series from the ledgers, so a series without one could be dropped).
            const appRaw = await redis.get("pm:appendix-daily-values");
            if (appRaw) {
              const app = JSON.parse(appRaw) as { ledgers: { profile: string }[] };
              if (Array.isArray(app.ledgers) && !app.ledgers.some((l) => l.profile === "thematic")) {
                const ledger = { profile: "thematic", entries: model.history.map((p) => ({ ...p, addedAt: at })) };
                await redis.set("pm:appendix-daily-values", JSON.stringify({ ...app, ledgers: [...app.ledgers, ledger] }));
              }
            }
          } else {
            thematicSeries = "already exists — untouched";
          }
        }
      } catch (e) {
        log.warn("thematic series seed failed (models already applied):", e);
        thematicSeries = "seed failed";
      }
    }

    const diff = diffModels(models, nextModels);
    log.info(`applied "${draft.name}" — ${staged.length} models, ${diff.length} weight changes, snapshot ${versionId}`);
    return NextResponse.json({ ok: true, versionId, revision: nextModels.revision, diff, exits, roles, thematicSeries, sleeveTargets: Object.keys(roles).length ? sleeveTargets : undefined });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "apply failed" }, { status: 500 });
  }
}
