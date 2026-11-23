import { NextRequest, NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import {
  computeGrowthScore, GROWTH_BANDS_KEY, GROWTH_DETAIL_KEY, GROWTH_SOURCE_FIELDS, GROWTH_DERIVATIONS, GROWTH_METRIC_LABEL,
  GROWTH_WEIGHTS, GROWTH_CUTS, TOP_MARK_FLOOR_PCT, MIN_GROUP_SIZE, MIN_EPS_BASE, BASIS_BREAK_SALES_PCT, REVISION_TRIGGER_PCT, GROUP_METRIC_RULES,
  type GrowthBands, type GrowthDetail,
} from "@/app/lib/growth-score";
import { bandsHealth } from "@/app/lib/score-input-validation";
import { pickSpotCheckSet, spotCheckCard, spotCheckCsv, verificationStatus, SCORING_VERIFICATION_KEY, type SpotRow } from "@/app/lib/scoring-verification";

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
 * Also (Nov 2026 audit): the bands' health and stored self-checks, the
 * SPOT-CHECK SET (~12 companies covering the awkward cases, each with its
 * exact formulas, stored values and arithmetic) and whether a person has
 * recorded a check against a FactSet terminal (pm:scoring-verification,
 * read-only here). `?spot=1` returns just that; `?spot=csv` downloads the
 * spot-check set as a CSV to fill in at the terminal.
 *
 * Never writes. { stored: false } until the calibration route has been run.
 */
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const spot = new URL(req.url).searchParams.get("spot");
    const redis = await getRedis();
    const [rawBands, rawDetail, rawVerif] = await Promise.all([redis.get(GROWTH_BANDS_KEY), redis.get(GROWTH_DETAIL_KEY), redis.get(SCORING_VERIFICATION_KEY).catch(() => null)]);
    if (!rawBands || !rawDetail) return NextResponse.json({ stored: false, haveBands: !!rawBands, haveDetail: !!rawDetail });
    const bands = JSON.parse(rawBands) as GrowthBands;
    const detail = JSON.parse(rawDetail) as GrowthDetail;
    const spotRows = detail.rows as unknown as SpotRow[];
    const picks = pickSpotCheckSet(spotRows);
    const cards = picks.map((p) => spotCheckCard("growth", spotRows.find((r) => r.ticker === p.ticker)!, p));
    let verifLog: unknown = null;
    try { verifLog = rawVerif ? JSON.parse(rawVerif) : null; } catch { /* unreadable log → shown as not verified */ }
    const audit = {
      health: bandsHealth(bands),
      selfChecks: bands.selfChecks ?? null,
      verification: verificationStatus(verifLog, "growth", bands.calibratedAt),
      spotCheck: cards,
      spotCheckNote: "Not covered automatically: a company that has just rolled its fiscal year — add one by hand (any company that reported its fourth quarter in the last few weeks).",
    };
    if (spot === "csv") return new NextResponse(spotCheckCsv("growth", cards, bands.calibratedAt), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="growth-spot-check-${bands.calibratedAt.slice(0, 10)}.csv"` } });
    if (spot === "1") return NextResponse.json({ stored: true, score: "growth", calibratedAt: bands.calibratedAt, inSync: detail.calibratedAt === bands.calibratedAt, ...audit });
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
      ...audit,
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
