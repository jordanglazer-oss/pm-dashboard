/**
 * Computed growth score (rubric revision 7) — pure arithmetic, no I/O.
 *
 * Replaces the hand-set sector growth bands (written by judgment in July 2026
 * with no data behind them) with a score the app computes and SHOWS:
 *
 *   1. Four metrics, each ranked as a percentile inside the company's own
 *      peer group (its sector playbook; folded into the GICS sector when the
 *      playbook group is too small to rank in).
 *   2. A weighted blend of those percentiles mapped to 0–3, with the top mark
 *      reserved for genuinely outstanding growth (top ~15%, broad-based, and
 *      above an absolute floor).
 *   3. A symmetric, computed estimate-revision adjustment.
 *
 * The model no longer derives the growth score. It receives the computed
 * result and may move it by at most ONE point for a named reason.
 *
 * Every number used is returned in `GrowthWorking` so the stock page and the
 * Methodology page can show the full calculation — nothing here is a black box.
 *
 * The weights / cuts / floor below are STARTING VALUES, set against real data
 * at the calibration check-in (/api/admin/growth-band-calibration).
 */

/** Redis key holding the calibrated peer-group distributions (regenerable cache). */
export const GROWTH_BANDS_KEY = "pm:growth-bands";

export type GrowthMetricKey = "fwdSales" | "fwdEps" | "ltg" | "delivered";

export const GROWTH_METRIC_LABEL: Record<GrowthMetricKey, string> = {
  fwdSales: "Forward sales growth (next 12m consensus ÷ last 12m)",
  fwdEps: "Forward EPS growth (next 12m consensus ÷ last 12m actual)",
  ltg: "Long-term growth (3–5y consensus EPS estimate)",
  delivered: "Delivered growth (trailing 3-year, per year)",
};

export const GROWTH_WEIGHTS: Record<GrowthMetricKey, number> = { fwdSales: 0.3, fwdEps: 0.3, ltg: 0.2, delivered: 0.2 };
/** Blended-percentile cut points: below `one` → 0, below `two` → 1, below `three` → 2, else top-mark tests. */
export const GROWTH_CUTS = { one: 20, two: 50, three: 85 };
/** A 3 also needs forward growth on the primary metric of at least this (%). */
export const TOP_MARK_FLOOR_PCT = 5;
/** A playbook group smaller than this is ranked inside its GICS sector instead.
 *  7, not 12: telecom (7 names), pharma (7) and biotech (8) would otherwise fold
 *  into their whole sector — telecom ranked against Meta and Alphabet is exactly
 *  the mismatch peer groups exist to avoid. Coarser percentiles are the lesser evil. */
export const MIN_GROUP_SIZE = 7;
/** Forward sales at or below this (%) while forward EPS is flat or rising is a
 *  REPORTING-BASIS BREAK, not a shrinking business: consensus is net revenue or
 *  post-spin-off while the trailing figure is gross or pre-spin (Goldman read
 *  -46%, Honeywell -48% in the first calibration). The metric is dropped. */
export const BASIS_BREAK_SALES_PCT = -10;
/** FY+1 consensus moved more than this (%) in 3 months → ±1. Symmetric. */
export const REVISION_TRIGGER_PCT = 3;
/** Forward EPS growth is undefined off a tiny or negative base. */
export const MIN_EPS_BASE = 0.1;

/** Per-playbook metric handling. `drop` = not meaningful for this business
 *  model (weights re-normalise over what is left). `deliveredFrom` swaps the
 *  delivered-growth input. Groups not listed use all four metrics. */
export const GROUP_METRIC_RULES: Record<string, { drop?: GrowthMetricKey[]; deliveredFrom?: "bookValue"; note: string }> = {
  Banks: { drop: ["fwdSales"], deliveredFrom: "bookValue", note: "Revenue is not how a bank is graded; delivered growth is book value per share." },
  Insurance: { drop: ["fwdSales"], deliveredFrom: "bookValue", note: "Revenue (premiums) is volume, not value; delivered growth is book value per share." },
  "REITs / Real Estate": { drop: ["fwdEps", "ltg"], note: "GAAP EPS is distorted by depreciation and FFO is not in the FactSet feed; ranked on revenue growth, forward and delivered. FFO evidence from a report can support the one-point adjustment." },
};

export type RawGrowthRow = {
  salesNtm?: number | null; salesLtm?: number | null;
  /** Trailing-12-month sales ON THE ESTIMATES BASIS (FE_ESTIMATE … LTMA) — the
   *  same basis as salesNtm, so net-vs-gross revenue cannot distort the growth
   *  rate. Preferred over salesLtm (as-reported) whenever it is available. */
  salesLtmA?: number | null;
  epsNtm?: number | null; epsLtmA?: number | null;
  ltg?: number | null;
  salesAnn0?: number | null; salesAnn3?: number | null;
  bpsAnn0?: number | null; bpsAnn3?: number | null;
};

export type GrowthInputs = Partial<Record<GrowthMetricKey, number>>;
export type GrowthExclusion = { metric: GrowthMetricKey; reason: string };

const num = (v: unknown): v is number => typeof v === "number" && isFinite(v);
const cagr3 = (now: number, then: number): number => (Math.pow(now / then, 1 / 3) - 1) * 100;

/** Raw FactSet fields → the four growth metrics (in %), with a reason for each one that could not be formed. */
export function deriveGrowthInputs(raw: RawGrowthRow, group: string | null): { inputs: GrowthInputs; excluded: GrowthExclusion[] } {
  const rule = group ? GROUP_METRIC_RULES[group] : undefined;
  const dropped = new Set(rule?.drop ?? []);
  const inputs: GrowthInputs = {};
  const excluded: GrowthExclusion[] = [];
  const skip = (metric: GrowthMetricKey, reason: string) => excluded.push({ metric, reason });

  const salesBase = num(raw.salesLtmA) && raw.salesLtmA > 0 ? raw.salesLtmA : raw.salesLtm;
  if (dropped.has("fwdSales")) skip("fwdSales", "not meaningful for this business model");
  else if (num(raw.salesNtm) && num(salesBase) && salesBase > 0) inputs.fwdSales = ((raw.salesNtm - salesBase) / salesBase) * 100;
  else skip("fwdSales", "no next-12-month sales consensus or no trailing sales");

  if (dropped.has("fwdEps")) skip("fwdEps", "not meaningful for this business model");
  else if (num(raw.epsNtm) && num(raw.epsLtmA)) {
    if (raw.epsLtmA >= MIN_EPS_BASE) inputs.fwdEps = ((raw.epsNtm - raw.epsLtmA) / raw.epsLtmA) * 100;
    else skip("fwdEps", `trailing EPS base of ${raw.epsLtmA.toFixed(2)} is negative or too small to grow from`);
  } else skip("fwdEps", "no next-12-month EPS consensus or no trailing actual");

  // Reporting-basis break: sales "collapsing" while earnings grow.
  if (inputs.fwdSales != null && inputs.fwdSales <= BASIS_BREAK_SALES_PCT && inputs.fwdEps != null && inputs.fwdEps >= 0) {
    const was = inputs.fwdSales;
    delete inputs.fwdSales;
    skip("fwdSales", `forward and trailing revenue are on different bases (a spin-off, divestiture, or net-versus-gross reporting): it read ${was.toFixed(0)}% while forward EPS is growing`);
  }

  if (dropped.has("ltg")) skip("ltg", "not meaningful for this business model");
  else if (num(raw.ltg)) inputs.ltg = raw.ltg;
  else skip("ltg", "no long-term growth estimate");

  if (rule?.deliveredFrom === "bookValue") {
    if (num(raw.bpsAnn0) && num(raw.bpsAnn3) && raw.bpsAnn0 > 0 && raw.bpsAnn3 > 0) inputs.delivered = cagr3(raw.bpsAnn0, raw.bpsAnn3);
    else skip("delivered", "no 3-year book value per share history");
  } else if (num(raw.salesAnn0) && num(raw.salesAnn3) && raw.salesAnn0 > 0 && raw.salesAnn3 > 0) inputs.delivered = cagr3(raw.salesAnn0, raw.salesAnn3);
  else skip("delivered", "no 3-year revenue history");

  return { inputs, excluded };
}

/** One peer group's distributions: each metric's values, sorted ascending, winsorised at the 2nd / 98th percentile. */
export type GrowthGroup = { group: string; n: number; metrics: Partial<Record<GrowthMetricKey, number[]>> };
export type GrowthBands = {
  calibratedAt: string;
  universeSize: number;
  listVersion: string;
  /** Playbook-level groups and GICS-sector groups (the fold-in target). */
  groups: Record<string, GrowthGroup>;
  sectors: Record<string, GrowthGroup>;
};

export function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = (sorted.length - 1) * (p / 100);
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export function winsorSort(values: number[]): number[] {
  const s = [...values].sort((a, b) => a - b);
  if (s.length < 10) return s;
  const lo = quantile(s, 2)!, hi = quantile(s, 98)!;
  return s.map((v) => Math.min(hi, Math.max(lo, v)));
}

/** Mid-rank percentile (0–100) of `v` within `sorted`. */
export function percentileOf(sorted: number[], v: number): number {
  if (sorted.length === 0) return 50;
  let below = 0, equal = 0;
  for (const x of sorted) { if (x < v) below++; else if (x === v) equal++; }
  return ((below + equal / 2) / sorted.length) * 100;
}

export type GrowthComponent = {
  metric: GrowthMetricKey;
  label: string;
  value: number;
  percentile: number;
  weight: number;
  groupMedian: number | null;
};

export type GrowthWorking = {
  /** The group the name was ranked in, how many names it holds, and whether a small playbook group was folded into its sector. */
  rankedIn: string;
  groupSize: number;
  foldedFrom: string | null;
  groupNote: string | null;
  components: GrowthComponent[];
  excluded: GrowthExclusion[];
  blendedPercentile: number | null;
  baseScore: number | null;
  topMark: { inTopBand: boolean; noMetricBelowMedian: boolean; clearsFloor: boolean; primaryForwardGrowth: number | null } | null;
  revision: { pct: number | null; adjustment: -1 | 0 | 1 };
  /** Base score + revision adjustment, held to 0–3. null → too few metrics: DATA GAP. */
  computedScore: number | null;
  calibratedAt: string;
};

/**
 * The computed growth score for one company.
 * `revisionPct` = % change in FY+1 consensus over 3 months on the SAME fiscal year.
 */
export function computeGrowthScore(args: {
  raw: RawGrowthRow;
  playbookGroup: string | null;
  sector: string | null;
  bands: GrowthBands;
  revisionPct: number | null;
}): GrowthWorking {
  const { raw, playbookGroup, sector, bands, revisionPct } = args;
  const pg = playbookGroup ? bands.groups[playbookGroup] : undefined;
  const sg = sector ? bands.sectors[sector] : undefined;
  const usePlaybook = !!pg && pg.n >= MIN_GROUP_SIZE;
  const dist = usePlaybook ? pg : sg ?? pg;
  const { inputs, excluded } = deriveGrowthInputs(raw, playbookGroup);

  const components: GrowthComponent[] = [];
  for (const metric of Object.keys(GROWTH_WEIGHTS) as GrowthMetricKey[]) {
    const value = inputs[metric];
    const sorted = dist?.metrics[metric];
    if (value == null) continue;
    if (!sorted || sorted.length < MIN_GROUP_SIZE) { excluded.push({ metric, reason: "peer group too thin to rank this metric" }); continue; }
    components.push({ metric, label: GROWTH_METRIC_LABEL[metric], value, percentile: percentileOf(sorted, value), weight: GROWTH_WEIGHTS[metric], groupMedian: quantile(sorted, 50) });
  }
  const wSum = components.reduce((s, c) => s + c.weight, 0);
  for (const c of components) c.weight = wSum > 0 ? c.weight / wSum : 0;

  const revAdj: -1 | 0 | 1 = revisionPct == null ? 0 : revisionPct > REVISION_TRIGGER_PCT ? 1 : revisionPct < -REVISION_TRIGGER_PCT ? -1 : 0;
  const base: GrowthWorking = {
    rankedIn: dist?.group ?? "unranked",
    groupSize: dist?.n ?? 0,
    foldedFrom: !usePlaybook && pg && sg ? pg.group : null,
    groupNote: playbookGroup ? GROUP_METRIC_RULES[playbookGroup]?.note ?? null : null,
    components, excluded,
    blendedPercentile: null, baseScore: null, topMark: null,
    revision: { pct: revisionPct, adjustment: revAdj },
    computedScore: null,
    calibratedAt: bands.calibratedAt,
  };
  if (components.length < 2) return base; // too little to rank on → DATA GAP flow

  const blended = components.reduce((s, c) => s + c.percentile * c.weight, 0);
  // Primary forward metric: sales where it is used, else EPS.
  const primary = inputs.fwdSales ?? inputs.fwdEps ?? null;
  const inTopBand = blended >= GROWTH_CUTS.three;
  const noMetricBelowMedian = components.every((c) => c.percentile >= 50);
  const clearsFloor = primary != null && primary >= TOP_MARK_FLOOR_PCT;
  let score: number;
  if (primary != null && primary < 0) score = 0;
  else if (blended < GROWTH_CUTS.one) score = 0;
  else if (blended < GROWTH_CUTS.two) score = 1;
  else if (inTopBand && noMetricBelowMedian && clearsFloor) score = 3;
  else score = 2;

  return {
    ...base,
    blendedPercentile: Math.round(blended * 10) / 10,
    baseScore: score,
    topMark: { inTopBand, noMetricBelowMedian, clearsFloor, primaryForwardGrowth: primary },
    computedScore: Math.max(0, Math.min(3, score + revAdj)),
  };
}

/** The named reasons the model may use for its single one-point adjustment. */
export const MODEL_ADJUSTMENT_REASONS = [
  "growth flattered by a one-off being lapped",
  "peak-cycle earnings",
  "growth bought through acquisition",
  "a disclosed event not yet in consensus",
] as const;

/** Compact copy of the growth working for a pm:score-history entry (additive, optional). */
export function growthHistoryField(expl: unknown): { growth?: { computed: number | null; final: number; adj: number; rev: number; blended: number | null; group: string; n: number; m: Record<string, [number, number]> } } {
  if (!expl || Array.isArray(expl) || typeof expl !== "object") return {};
  const c = (expl as { growthCalc?: GrowthWorking & { modelScore: number; modelAdjustment: number } }).growthCalc;
  if (!c) return {};
  return {
    growth: {
      computed: c.computedScore, final: c.modelScore, adj: c.modelAdjustment, rev: c.revision.adjustment,
      blended: c.blendedPercentile, group: c.rankedIn, n: c.groupSize,
      m: Object.fromEntries(c.components.map((x) => [x.metric, [Math.round(x.value * 10) / 10, Math.round(x.percentile)] as [number, number]])),
    },
  };
}
