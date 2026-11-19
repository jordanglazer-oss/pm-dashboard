import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { createLogger } from "@/app/lib/logger";
import { planManagedAlphaBackfill, type AppendixBlob } from "@/app/lib/managed-alpha-backfill";
import type { BucketStock } from "@/app/lib/sleeve-targets";
import type { PimModelData, PimPerformanceData, PimPortfolioState } from "@/app/lib/pim-types";

/**
 * GET /api/admin/backfill-managed-alpha
 *     [?from=2026-10-21][&alphaCut=2026-11-11][&rebuildAlpha=1]
 *     [&entry=GRNY:2026-10-28,…][&exclude=SYM,…][&confirm=YES]
 *
 * Rebuilds the Managed Alpha series (pim|thematic) back to the `from`
 * rebalance, and optionally Total Alpha over the same stretch — see
 * app/lib/managed-alpha-backfill.ts for the exact rules.
 *
 * DRY RUN by default: reads pm:pim-models, pm:stocks, pm:pim-performance,
 * pm:appendix-daily-values and pm:pim-portfolio-state, and returns the
 * holdings list with each entry date, every day it would add, and every
 * Total Alpha day it would change (before / after). Writes NOTHING.
 *
 * `&confirm=YES` writes pm:pim-performance and pm:appendix-daily-values ONLY,
 * after stashing both at `<key>.pre-managed-alpha-backfill-<ts>`. It re-reads
 * pm:pim-performance right before writing and refuses if it changed while the
 * plan was being built (the daily job runs 21:30 UTC on weekdays). It refuses
 * to run twice (the series no longer starts with a flat placeholder).
 * To undo: copy the two stashes back over their keys.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const log = createLogger("Backfill-managed-alpha");
const PERF = "pm:pim-performance";
const APPX = "pm:appendix-daily-values";
const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function GET(req: NextRequest) {
  try {
    const q = new URL(req.url).searchParams;
    const from = q.get("from") ?? "2026-10-21";
    const alphaCut = q.get("alphaCut") ?? "2026-11-11";
    if (!isDate(from) || !isDate(alphaCut)) return NextResponse.json({ error: "from / alphaCut must be YYYY-MM-DD" }, { status: 400 });
    const entryOverrides: Record<string, string> = {};
    for (const part of (q.get("entry") ?? "").split(",").filter(Boolean)) {
      const [sym, d] = part.split(":");
      if (!sym || !isDate(d ?? null)) return NextResponse.json({ error: `bad entry override "${part}" — use SYMBOL:YYYY-MM-DD` }, { status: 400 });
      entryOverrides[sym.trim().toUpperCase()] = d;
    }
    const exclude = (q.get("exclude") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const confirm = q.get("confirm") === "YES";

    const redis = await getRedis();
    const [modelsRaw, stocksRaw, perfRaw, appxRaw, stateRaw] = await Promise.all([redis.get("pm:pim-models"), redis.get("pm:stocks"), redis.get(PERF), redis.get(APPX), redis.get("pm:pim-portfolio-state")]);
    if (!modelsRaw || !perfRaw) return NextResponse.json({ error: "pm:pim-models or pm:pim-performance is missing" }, { status: 409 });
    const stocksParsed = stocksRaw ? JSON.parse(stocksRaw) : [];
    const stocks: BucketStock[] = Array.isArray(stocksParsed) ? stocksParsed : (stocksParsed?.stocks ?? []);

    const plan = await planManagedAlphaBackfill(
      {
        models: JSON.parse(modelsRaw) as PimModelData,
        stocks,
        perf: JSON.parse(perfRaw) as PimPerformanceData,
        appendix: appxRaw ? (JSON.parse(appxRaw) as AppendixBlob) : null,
        state: stateRaw ? (JSON.parse(stateRaw) as PimPortfolioState) : null,
      },
      { from, alphaCut, rebuildAlpha: q.get("rebuildAlpha") === "1", entryOverrides, exclude },
    );
    const { next, ...report } = plan;
    if (!plan.ok || !next) return NextResponse.json({ mode: "refused", ...report }, { status: 409 });
    if (!confirm) return NextResponse.json({ mode: "DRY RUN — nothing written", params: { from, alphaCut, rebuildAlpha: q.get("rebuildAlpha") === "1", entryOverrides, exclude }, ...report });

    // Write: re-read, refuse if the series moved underneath us, stash, then set.
    const perfNow = await redis.get(PERF);
    if (perfNow !== perfRaw) return NextResponse.json({ mode: "refused", refuse: "pm:pim-performance changed while the plan was being built — run it again", notes: report.notes }, { status: 409 });
    const stamp = Date.now();
    await redis.set(`${PERF}.pre-managed-alpha-backfill-${stamp}`, perfRaw);
    if (appxRaw) await redis.set(`${APPX}.pre-managed-alpha-backfill-${stamp}`, appxRaw);
    await redis.set(PERF, JSON.stringify(next.perf));
    if (next.appendix) await redis.set(APPX, JSON.stringify(next.appendix));
    log.info(`written; stashes .pre-managed-alpha-backfill-${stamp}`);
    return NextResponse.json({ mode: "WRITTEN", stashes: [`${PERF}.pre-managed-alpha-backfill-${stamp}`, appxRaw ? `${APPX}.pre-managed-alpha-backfill-${stamp}` : null].filter(Boolean), ...report });
  } catch (e) {
    log.error("failed:", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : "failed" }, { status: 500 });
  }
}
