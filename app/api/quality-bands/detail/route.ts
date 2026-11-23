import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import {
  computeQualityScore, QUALITY_BANDS_KEY, QUALITY_DETAIL_KEY, QUALITY_SOURCE_FIELDS, QUALITY_METRIC_LABEL, QUALITY_WEIGHTS, QUALITY_CUTS,
  QUALITY_TOP_MARK_FLOOR_PCT, QUALITY_GROUP_RULES, QUALITY_SANITY, MIN_GROUP_SIZE, type QualityBands, type QualityDetail,
} from "@/app/lib/quality-score";

/**
 * GET /api/quality-bands/detail — the SHADOW quality score's audit trail,
 * read-only (the quality twin of /api/growth-bands/detail).
 *
 * For every company in the calibration universe: the raw FactSet inputs, the
 * derived measures, each one's percentile inside its peer group, the blend
 * and the score — recomputed HERE with computeQualityScore, the same function
 * /api/scoring-shadow uses. Also the exact FactSet formulas, and a count of
 * how the scores fall (to judge the starting cut points).
 *
 * Never writes. { stored: false } until the calibration has been run with
 * confirm=YES.
 */
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const redis = await getRedis();
    const [rawBands, rawDetail] = await Promise.all([redis.get(QUALITY_BANDS_KEY), redis.get(QUALITY_DETAIL_KEY)]);
    if (!rawBands || !rawDetail) return NextResponse.json({ stored: false, haveBands: !!rawBands, haveDetail: !!rawDetail });
    const bands = JSON.parse(rawBands) as QualityBands;
    const detail = JSON.parse(rawDetail) as QualityDetail;
    const rows = detail.rows.map((r) => {
      const w = computeQualityScore({ raw: r.raw, playbookGroup: r.group, sector: r.sector, bands });
      return {
        ticker: r.ticker, country: r.country, marketCapM: r.marketCap, sector: r.sector, industry: r.industry, group: r.group,
        rankedIn: w.rankedIn, groupSize: w.groupSize, foldedFrom: w.foldedFrom, returnsBasis: w.returnsBasis,
        raw: r.raw,
        metrics: Object.fromEntries(w.components.map((c) => [c.metric, { value: c.value, percentile: c.percentile, weight: c.weight, groupMedian: c.groupMedian }])),
        excluded: w.excluded, blended: w.blendedPercentile, topMark: w.topMark, score: w.computedScore, gapReason: w.gapReason,
      };
    });
    const tally = (list: typeof rows) => ({ names: list.length, two: list.filter((r) => r.score === 2).length, one: list.filter((r) => r.score === 1).length, zero: list.filter((r) => r.score === 0).length, dataGap: list.filter((r) => r.score == null).length });
    return NextResponse.json({
      stored: true,
      shadowOnly: "No live score reads these numbers.",
      calibratedAt: detail.calibratedAt,
      inSync: detail.calibratedAt === bands.calibratedAt,
      universeSize: rows.length,
      droppedNoSector: detail.droppedNoSector ?? [],
      scoreSpread: { all: tally(rows), us: tally(rows.filter((r) => r.country === "US")), canada: tally(rows.filter((r) => r.country === "CA")) },
      sources: QUALITY_SOURCE_FIELDS,
      metricLabels: QUALITY_METRIC_LABEL,
      method: { weights: QUALITY_WEIGHTS, cuts: QUALITY_CUTS, topMarkFloorPct: QUALITY_TOP_MARK_FLOOR_PCT, minGroupSize: MIN_GROUP_SIZE, sanityRanges: QUALITY_SANITY, groupRules: QUALITY_GROUP_RULES },
      rows,
    });
  } catch (e) {
    return NextResponse.json({ stored: false, error: e instanceof Error ? e.message : String(e) });
  }
}
