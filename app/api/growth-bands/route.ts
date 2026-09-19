import { NextResponse } from "next/server";
import { getRedis } from "@/app/lib/redis";
import { GROWTH_BANDS_KEY, GROWTH_CUTS, GROWTH_WEIGHTS, GROUP_METRIC_RULES, MIN_GROUP_SIZE, TOP_MARK_FLOOR_PCT, quantile, type GrowthBands, type GrowthGroup, type GrowthMetricKey } from "@/app/lib/growth-score";

/**
 * GET /api/growth-bands — read-only summary of the calibrated peer-group growth
 * bands (pm:growth-bands) for the Methodology page: each group's size and its
 * cut points per metric, plus the method constants. Never writes. Returns
 * { stored: false } when the bands have not been calibrated.
 */
export const dynamic = "force-dynamic";

const METRICS: GrowthMetricKey[] = ["fwdSales", "fwdEps", "ltg", "delivered"];

function cuts(g: GrowthGroup) {
  return Object.fromEntries(METRICS.map((m) => {
    const s = g.metrics[m];
    return [m, s && s.length ? { n: s.length, p20: quantile(s, GROWTH_CUTS.one), median: quantile(s, 50), p85: quantile(s, GROWTH_CUTS.three) } : null];
  }));
}

export async function GET() {
  try {
    const raw = await (await getRedis()).get(GROWTH_BANDS_KEY);
    if (!raw) return NextResponse.json({ stored: false });
    const b = JSON.parse(raw) as GrowthBands;
    return NextResponse.json({
      stored: true,
      calibratedAt: b.calibratedAt,
      universeSize: b.universeSize,
      method: { weights: GROWTH_WEIGHTS, cuts: GROWTH_CUTS, topMarkFloorPct: TOP_MARK_FLOOR_PCT, minGroupSize: MIN_GROUP_SIZE },
      groups: Object.values(b.groups).sort((a, c) => c.n - a.n).map((g) => ({ group: g.group, names: g.n, ownGroup: g.n >= MIN_GROUP_SIZE, rule: GROUP_METRIC_RULES[g.group]?.note ?? null, cutPoints: cuts(g) })),
      sectors: Object.values(b.sectors).sort((a, c) => c.n - a.n).map((g) => ({ group: g.group, names: g.n, cutPoints: cuts(g) })),
    });
  } catch {
    return NextResponse.json({ stored: false });
  }
}
