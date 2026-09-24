import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { WEIGHT_COMMIT_ENABLED, WEIGHT_DECISIONS_KEY, applyDecisions, inheritDecisions, reconcile, type WeightDecisionStore } from "@/app/lib/weight-decisions";
import { snapshotModels, diffModels } from "@/app/lib/model-versions";
import type { PimModelData } from "@/app/lib/pim-types";
import type { Stock } from "@/app/lib/types";

/**
 * POST /api/weight-decisions/commit — turn a month's decisions into model targets.
 * Body: { month: "YYYY-MM", confirm: "COMMIT YYYY-MM" }
 *
 * In order, and it stops at the first failure:
 *   1. the month must exist, be a draft, and have at least one decision;
 *   2. `confirm` must be exactly "COMMIT <month>";
 *   3. reconcile() is re-run server-side against the LIVE model — every sleeve
 *      nets to zero, no stock breaches the 10%-of-portfolio cap, nothing untagged;
 *   4. the current pm:pim-models is snapshotted (pm:pim-models-version:<id>);
 *   5. PIM gets applyDecisions() (adopt / set pin the holding; release unpins),
 *      every other model inheritDecisions(); non-equity holdings and unknown
 *      fields pass through untouched; revision is bumped so stale tabs are refused;
 *   6. the month is marked committed with the version id;
 *   7. each adopt / set / release is journaled.
 * Returns the diff per model.
 */

const log = createLogger("Weight-commit");

export async function POST(req: NextRequest) {
  if (!WEIGHT_COMMIT_ENABLED) return NextResponse.json({ error: "commit is disabled on this build" }, { status: 409 });
  try {
    const body = (await req.json().catch(() => ({}))) as { month?: string; confirm?: string };
    const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : "";
    if (!month) return NextResponse.json({ error: "month (YYYY-MM) required" }, { status: 400 });
    if (body.confirm !== `COMMIT ${month}`) return NextResponse.json({ error: `type COMMIT ${month} to confirm` }, { status: 400 });

    const redis = await getRedis();
    const [storeRaw, pimRaw, stocksRaw] = await Promise.all([redis.get(WEIGHT_DECISIONS_KEY), redis.get("pm:pim-models"), redis.get("pm:stocks")]);
    const store: WeightDecisionStore = storeRaw ? JSON.parse(storeRaw) : { months: {} };
    const review = store.months?.[month];
    if (!review) return NextResponse.json({ error: `no decisions drafted for ${month}` }, { status: 404 });
    if (review.status === "committed") return NextResponse.json({ error: `${month} is already committed` }, { status: 409 });
    const decided = Object.keys(review.decisions ?? {}).length;
    if (decided === 0) return NextResponse.json({ error: "nothing decided" }, { status: 400 });
    if (!pimRaw) return NextResponse.json({ error: "no models on file" }, { status: 500 });
    const models = JSON.parse(pimRaw) as PimModelData;
    const stocks = (stocksRaw ? JSON.parse(stocksRaw) : []) as Stock[];
    const groupId = review.groupId || "pim";
    const pim = models.groups.find((g) => g.id === groupId);
    if (!pim) return NextResponse.json({ error: `model ${groupId} not found` }, { status: 404 });

    // 3. Reconcile against the live model, never the client's view of it.
    const recon = reconcile(pim, stocks, review.decisions);
    if (!recon.ok) {
      return NextResponse.json({ error: "decisions do not reconcile against the live model", recon }, { status: 409 });
    }

    // 4. Snapshot first — this is the undo.
    const versionId = await snapshotModels("review-commit", `before ${month} review commit (${decided} decisions)`, month);
    if (!versionId) return NextResponse.json({ error: "could not snapshot the current models — nothing written" }, { status: 500 });

    // 5. Apply to PIM, inherit everywhere else. Read-modify-write on the blob just read.
    const nextGroups = models.groups.map((g) => (g.id === groupId ? applyDecisions(g, review.decisions, month) : inheritDecisions(pim, g, stocks, review.decisions)));
    // Every equity sleeve must still sum to 1 — refuse rather than write a broken model.
    for (const g of nextGroups) {
      const eq = g.holdings.filter((h) => h.assetClass === "equity").reduce((a, h) => a + h.weightInClass, 0);
      if (g.holdings.some((h) => h.assetClass === "equity") && Math.abs(eq - 1) > 0.002) {
        return NextResponse.json({ error: `${g.name}: equity would sum to ${(eq * 100).toFixed(2)}% — nothing written (snapshot ${versionId} kept)` }, { status: 409 });
      }
    }
    const nextModels: PimModelData = { ...models, groups: nextGroups, revision: (models.revision ?? 0) + 1, lastUpdated: new Date().toISOString() };
    await redis.set("pm:pim-models", JSON.stringify(nextModels));

    // 6. Mark the month committed (read-merge-write; other months untouched).
    const at = new Date().toISOString();
    const freshStoreRaw = await redis.get(WEIGHT_DECISIONS_KEY);
    const freshStore: WeightDecisionStore = freshStoreRaw ? JSON.parse(freshStoreRaw) : { months: {} };
    freshStore.months[month] = { ...(freshStore.months[month] ?? review), status: "committed", committedAt: at, stashKey: `pm:pim-models-version:${versionId}`, updatedAt: at };
    await redis.set(WEIGHT_DECISIONS_KEY, JSON.stringify(freshStore));

    // 7. Journal (read-merge-write; best effort).
    try {
      const jRaw = await redis.get("pm:decision-journal");
      // Store shape is { entries: DecisionEntry[] } (app/api/kv/decision-journal).
      const jBlob = jRaw ? (JSON.parse(jRaw) as { entries?: unknown[] }) : { entries: [] };
      const journal: unknown[] = Array.isArray(jBlob.entries) ? jBlob.entries : [];
      const entries = Object.entries(review.decisions).filter(([, d]) => d.action !== "keep").map(([symbol, d]) => {
        const before = pim.holdings.find((h) => h.symbol === symbol)?.weightInClass ?? null;
        const after = nextGroups.find((g) => g.id === groupId)?.holdings.find((h) => h.symbol === symbol)?.weightInClass ?? null;
        const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);
        return {
          id: `wd-${month}-${symbol}-${Date.now().toString(36)}`,
          date: at.slice(0, 10),
          timestamp: at,
          ticker: symbol.replace(/-T$/, ".TO"),
          action: d.action === "release" ? "hold" : after != null && before != null && after < before ? "trim" : "add",
          rationale: `${month} review — ${d.action}: ${pct(before)} → ${pct(after)} of equity${d.note ? ` · ${d.note}` : ""}`,
        };
      });
      await redis.set("pm:decision-journal", JSON.stringify({ ...jBlob, entries: [...journal, ...entries] }));
    } catch (e) {
      log.warn("journal write failed (commit already done):", e);
    }

    const diff = diffModels(models, nextModels);
    log.info(`${month} committed — ${decided} decisions, ${diff.length} weight changes, snapshot ${versionId}`);
    return NextResponse.json({ ok: true, month, versionId, revision: nextModels.revision, diff });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: "commit failed" }, { status: 500 });
  }
}
