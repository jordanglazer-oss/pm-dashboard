import {
  type FactorUniverse,
  type FactorMetric,
  LOWER_IS_BETTER,
} from "./factor-universe";

/**
 * Factor math (Phase A3) — pure functions, no I/O. Turn a stock's derived
 * metrics into sector-neutral z-scores, roll them into factor groups, and
 * produce a composite quant PERCENTILE (0–100) + confidence.
 *
 * This is the quant lens of the shadow scoring system. It reads NOTHING from
 * the 41-point score — its only inputs are raw-metric values and the universe
 * distribution (pm:factor-universe). Fully deterministic; no Claude, no writes.
 *
 * Weights are FIXED v1 constants — IC-driven weighting is a Phase C output and
 * deliberately not wired here.
 */

/** Metric → factor group. Revisions land later (needs universe revision data). */
export const FACTOR_GROUPS: Record<string, FactorMetric[]> = {
  quality: ["fcfMargin", "operMgn", "operMgnTrend", "roe", "accruals", "intCoverage", "debtEbitda"],
  growth: ["revGrowth", "epsGrowth"],
  valuation: ["pe", "pbk", "psales", "evEbitda", "fcfYield"],
  momentum: ["mom12_1", "mom6_1"],
};

/** v1 fixed weights (placeholders pending Phase C IC calibration). */
export const FACTOR_WEIGHTS: Record<string, number> = {
  quality: 0.3,
  growth: 0.2,
  valuation: 0.2,
  momentum: 0.3,
};

export type FactorScore = {
  sector: string;
  /** Mean z per factor group (present groups only). */
  groups: Record<string, number>;
  /** Per-metric z (sign-normalized so higher = better everywhere). */
  perMetric: Partial<Record<FactorMetric, number>>;
  /** Weighted composite z across available groups. */
  composite: number;
  /** Composite mapped to a 0–100 percentile via the normal CDF. */
  percentile: number;
  /** 0–100: data coverage × cross-group agreement. */
  confidence: number;
};

function meanStd(vals: number[]): { mean: number; std: number } {
  const n = vals.length;
  const mean = vals.reduce((a, b) => a + b, 0) / n;
  const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  return { mean, std: Math.sqrt(variance) };
}

/** z of a value vs a sector distribution: sign-flipped for lower-is-better,
 *  clamped to ±3. Null when the distribution is too thin or degenerate. */
function metricZ(metric: FactorMetric, value: number, dist: number[]): number | null {
  if (dist.length < 8) return null;
  const { mean, std } = meanStd(dist);
  if (std === 0 || !isFinite(std)) return null;
  let z = (value - mean) / std;
  if (LOWER_IS_BETTER.has(metric)) z = -z;
  return Math.max(-3, Math.min(3, z));
}

/** Standard normal CDF (Abramowitz-Stegun 7.1.26) → 0..1. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function stdev(vals: number[]): number {
  if (vals.length < 2) return 0;
  return meanStd(vals).std;
}

/**
 * Score one stock's metrics against its sector's distribution in the universe.
 * `metrics` is the output of deriveMetrics() for that stock (absent metrics
 * simply omitted). Returns null when the sector isn't in the universe or no
 * metric could be scored.
 */
export function computeFactorScore(
  metrics: Partial<Record<FactorMetric, number>>,
  sector: string,
  universe: FactorUniverse,
): FactorScore | null {
  const sectorStats = universe.sectors[sector];
  if (!sectorStats) return null;

  const perMetric: Partial<Record<FactorMetric, number>> = {};
  const groups: Record<string, number> = {};

  for (const [group, keys] of Object.entries(FACTOR_GROUPS)) {
    const zs: number[] = [];
    for (const k of keys) {
      const v = metrics[k];
      const dist = sectorStats.metrics[k];
      if (v == null || !dist) continue;
      const z = metricZ(k, v, dist);
      if (z == null) continue;
      perMetric[k] = Math.round(z * 100) / 100;
      zs.push(z);
    }
    if (zs.length) groups[group] = zs.reduce((a, b) => a + b, 0) / zs.length;
  }

  // Composite = weighted mean of AVAILABLE groups, reweighted to what's present
  // (a missing group doesn't drag the score — absent ≠ bad).
  let wsum = 0;
  let zsum = 0;
  for (const [g, w] of Object.entries(FACTOR_WEIGHTS)) {
    if (groups[g] != null) {
      zsum += groups[g] * w;
      wsum += w;
    }
  }
  if (wsum === 0) return null;
  const composite = zsum / wsum;
  const percentile = Math.round(normalCdf(composite) * 100);

  // Confidence: 60% metric coverage + 40% cross-group agreement.
  const totalMetrics = Object.values(FACTOR_GROUPS).flat().length;
  const coverage = Object.keys(perMetric).length / totalMetrics;
  const groupVals = Object.values(groups);
  const agreement = groupVals.length > 1 ? 1 - Math.min(1, stdev(groupVals) / 1.5) : 0.5;
  const confidence = Math.round((0.6 * coverage + 0.4 * agreement) * 100);

  const round2 = (x: number) => Math.round(x * 100) / 100;
  return {
    sector,
    groups: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, round2(v)])),
    perMetric,
    composite: round2(composite),
    percentile,
    confidence,
  };
}
