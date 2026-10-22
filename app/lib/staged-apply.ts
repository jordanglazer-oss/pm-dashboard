import { getRedis } from "./redis";
import { createLogger } from "./logger";
import { snapshotModels, diffModels } from "./model-versions";
import { readDraftStore } from "./model-drafts-store";
import { MODEL_DRAFTS_KEY, draftHasBuckets, sameSymbol, stagedBucket, validateHoldings, withPins, type ModelDraft, type StagingStock } from "./model-staging";
import type { EquityBucket, PimModelData, PimPerformanceData } from "./pim-types";

/* The write half of a Stage-changes apply, shared by POST /api/model-staging/apply
 * (models only) and POST /api/model-staging/rebalance (models + back-dated
 * trades). See the apply route's header for the full contract: revision guard,
 * validation, snapshot first, replace only staged groups' holdings, bucket
 * targets, draft → history, Thematic series seed. */

const log = createLogger("Model-staging-apply");
const HISTORY_MAX = 12;

export type ApplyResult =
  | {
      ok: true;
      versionId: string;
      before: PimModelData;
      after: PimModelData;
      diff: ReturnType<typeof diffModels>;
      exits: Record<string, string[]>;
      roles: Record<string, EquityBucket>;
      thematicSeries: string;
      sleeveTargets?: PimModelData["sleeveTargets"];
    }
  | { ok: false; status: number; body: Record<string, unknown> };

const etDate = (daysAgo: number) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(
    new Date(Date.now() - daysAgo * 86_400_000),
  );

/** The weekday before `date` (YYYY-MM-DD). */
export function prevWeekday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() - 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export async function applyDraft(opts: {
  draft: ModelDraft;
  expectedRevision: number | undefined;
  groupIds?: string[];
  /** Effective date (back-dated rebalance): stamps sleeveTargets.since and
   *  seeds the Thematic series with its base at this day's close. */
  effectiveDate?: string;
  note?: string;
}): Promise<ApplyResult> {
  const { draft } = opts;
  const redis = await getRedis();
  const [pimRaw, stocksRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks")]);
  if (!pimRaw) return { ok: false, status: 500, body: { error: "no models on file" } };
  const models = JSON.parse(pimRaw) as PimModelData;
  const liveRev = models.revision ?? 0;
  if (typeof opts.expectedRevision !== "number" || opts.expectedRevision !== liveRev) {
    return { ok: false, status: 409, body: { error: "the live models changed since you reviewed this draft — review the diff again", revision: liveRev } };
  }
  const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as StagingStock[];

  const wanted = Array.isArray(opts.groupIds) && opts.groupIds.length ? new Set(opts.groupIds) : null;
  const staged = Object.entries(draft.models).filter(([gid]) => (!wanted || wanted.has(gid)) && models.groups.some((g) => g.id === gid));
  if (staged.length === 0) return { ok: false, status: 400, body: { error: "nothing staged for any live model" } };

  const problems: string[] = [];
  for (const [gid, m] of staged) {
    const name = models.groups.find((g) => g.id === gid)?.name ?? gid;
    for (const e of validateHoldings(m.holdings)) problems.push(`${name}: ${e}`);
  }
  if (problems.length) return { ok: false, status: 409, body: { error: "draft does not validate — nothing written", problems } };

  const versionId = await snapshotModels("manual", opts.note ?? `before staged model apply "${draft.name}" (${staged.length} models)`);
  if (!versionId) return { ok: false, status: 500, body: { error: "could not snapshot the current models — nothing written" } };

  const at = new Date().toISOString();
  const since = opts.effectiveDate ? `${opts.effectiveDate}T20:00:00.000Z` : at;
  const month = (opts.effectiveDate ?? at).slice(0, 7);
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
    sleeveTargets = { core: r6(t.core), thematic: r6(t.thematic), alpha: r6(t.alpha), since };
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
  // inception base of 100 at the effective day's close (no fabricated history
  // — same as the Conservative seed). /api/update-daily-value accrues it from
  // the next day. Read-merge-write appending ONE model, pre-image stashed;
  // never touches existing series.
  let thematicSeries = "not needed";
  if (Object.keys(roles).length) {
    try {
      const perfRaw = await redis.get("pm:pim-performance");
      if (perfRaw) {
        const perf = JSON.parse(perfRaw) as PimPerformanceData;
        if (!perf.models.some((m) => m.groupId === "pim" && m.profile === "thematic")) {
          const baseDay = opts.effectiveDate ?? etDate(1);
          const dayBefore = opts.effectiveDate ? prevWeekday(opts.effectiveDate) : etDate(2);
          await redis.set(`pm:pim-performance.pre-thematic-seed-${Date.now()}`, perfRaw);
          const model = {
            groupId: "pim",
            profile: "thematic" as const,
            history: [
              { date: dayBefore, value: 100, dailyReturn: 0 },
              { date: baseDay, value: 100, dailyReturn: 0, anchored: true },
            ],
            lastUpdated: at,
          };
          await redis.set("pm:pim-performance", JSON.stringify({ ...perf, models: [...perf.models, model] }));
          thematicSeries = `seeded at 100 from ${baseDay}`;
          // Matching Appendix ledger (the Performance tile re-seeds a group's
          // series from the ledgers, so a series without one could be dropped).
          const appRaw = await redis.get("pm:appendix-daily-values");
          if (appRaw) {
            const app = JSON.parse(appRaw) as { ledgers: { profile: string }[] };
            if (Array.isArray(app.ledgers) && !app.ledgers.some((l) => l.profile === "thematic")) {
              const ledger = { profile: "thematic", entries: model.history.map((p) => ({ date: p.date, value: p.value, dailyReturn: p.dailyReturn, addedAt: at })) };
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
  return { ok: true, versionId, before: models, after: nextModels, diff, exits, roles, thematicSeries, sleeveTargets: Object.keys(roles).length ? sleeveTargets : undefined };
}
