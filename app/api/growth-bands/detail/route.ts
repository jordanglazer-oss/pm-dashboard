import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import {
  computeGrowthScore, GROWTH_BANDS_KEY, GROWTH_DETAIL_KEY, GROWTH_SOURCE_FIELDS, GROWTH_DERIVATIONS, GROWTH_METRIC_LABEL,
  GROWTH_WEIGHTS, GROWTH_CUTS, TOP_MARK_FLOOR_PCT, MIN_GROUP_SIZE, MIN_EPS_BASE, BASIS_BREAK_SALES_PCT, REVISION_TRIGGER_PCT, GROUP_METRIC_RULES,
  type GrowthBands, type GrowthDetail,
} from "@/app/lib/growth-score";

/**
 * GET /api/growth-bands/detail — the growth score's audit trail, read-only.
 *
 * For every company in the calibration universe: the raw FactSet inputs, the
 * four derived metrics, each metric's percentile within its peer group, the
 * blended percentile and the base score — recomputed HERE with the same
 * function the score route uses (computeGrowthScore), so what the page shows
 * is what scoring does. Also returns the exact FactSet formulas and the
 * derivation rules. The estimate-revision adjustment is NOT included: it is
 * read live at rescore time, per company, and shown on the stock page.
 *
 * Never writes. { stored: false } until the calibration route has been run.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const [rawBands, rawDetail] = await Promise.all([redis.get(GROWTH_BANDS_KEY), redis.get(GROWTH_DETAIL_KEY)]);
    if (!rawBands || !rawDetail) return NextResponse.json({ stored: false, haveBands: !!rawBands, haveDetail: !!rawDetail });
    const bands = JSON.parse(rawBands) as GrowthBands;
    const detail = JSON.parse(rawDetail) as GrowthDetail;
    const rows = detail.rows.map((r) => {
      const w = computeGrowthScore({ raw: r.raw, playbookGroup: r.group, sector: r.sector, bands, revisionPct: null });
      return {
        ticker: r.ticker, sector: r.sector, industry: r.industry, group: r.group,
        rankedIn: w.rankedIn, groupSize: w.groupSize, foldedFrom: w.foldedFrom,
        raw: r.raw,
        metrics: Object.fromEntries(w.components.map((c) => [c.metric, { value: c.value, percentile: c.percentile, weight: c.weight, groupMedian: c.groupMedian }])),
        excluded: w.excluded,
        blended: w.blendedPercentile, baseScore: w.baseScore, topMark: w.topMark,
      };
    });
    return NextResponse.json({
      stored: true,
      calibratedAt: detail.calibratedAt,
      inSync: detail.calibratedAt === bands.calibratedAt,
      universeSize: rows.length,
      droppedNoSector: detail.droppedNoSector ?? [],
      sources: GROWTH_SOURCE_FIELDS,
      derivations: GROWTH_DERIVATIONS,
      metricLabels: GROWTH_METRIC_LABEL,
      method: { weights: GROWTH_WEIGHTS, cuts: GROWTH_CUTS, topMarkFloorPct: TOP_MARK_FLOOR_PCT, minGroupSize: MIN_GROUP_SIZE, minEpsBase: MIN_EPS_BASE, basisBreakSalesPct: BASIS_BREAK_SALES_PCT, revisionTriggerPct: REVISION_TRIGGER_PCT, groupRules: GROUP_METRIC_RULES },
      rows,
    });
  } catch (e) {
    return NextResponse.json({ stored: false, error: e instanceof Error ? e.message : String(e) });
  }
}
