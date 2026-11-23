/**
 * Computed QUALITY score ("Returns & margins", max 2) — pure arithmetic, no I/O.
 *
 * SHADOW ONLY (Nov 2026). Nothing in /api/score, the scoring prompt or any
 * stored score reads this file. It exists so a peer-ranked quality score can
 * be shown BESIDE the live, model-judged one before anyone decides to switch.
 *
 * Why: the live `returnsMargins` category is judged by the model against
 * business-model norms it carries in its head, which in practice read as
 * fixed cut-offs that mega-caps clear easily. This ranks a company against
 * its own sector-playbook peer group instead — the same method, the same
 * groups, the same fold-into-sector rule and the same percentile helpers as
 * the computed growth score (app/lib/growth-score.ts).
 *
 *   1. Up to four measures, each a percentile inside the peer group:
 *      the LEVEL of returns on capital, its two-year DIRECTION, the operating
 *      margin, and its two-year DIRECTION.
 *   2. Business models where a measure does not mean what it says are handled
 *      in ONE table (QUALITY_GROUP_RULES): banks and insurers are ranked on
 *      ROE (banks also ROA), never on an operating margin; REITs are NOT
 *      ranked at all (ROE and margins are distorted by depreciation and FFO
 *      is not in the FactSet feed) — they park as DATA GAP.
 *   3. The weighted blend maps to 0–2 with the cut points in QUALITY_CUTS.
 *
 * Every number used is returned in `QualityWorking`. Missing inputs park the
 * category (computedScore null → DATA GAP); nothing is guessed and nothing
 * silently becomes a zero.
 *
 * The weights / cuts / floor are STARTING VALUES. They have not been set
 * against real data — that is what /api/admin/quality-band-calibration's dry
 * run is for.
 */

import { percentileOf, quantile, winsorSort, MIN_GROUP_SIZE } from "./growth-score";
import { bandsHealth, checkValue, type MetricExpectation, type SelfChecks } from "./score-input-validation";

export { MIN_GROUP_SIZE };

/** Redis key holding the calibrated peer-group distributions (regenerable cache). */
export const QUALITY_BANDS_KEY = "pm:quality-bands";
/** Redis key holding the per-company inputs behind the bands (audit trail). */
export const QUALITY_DETAIL_KEY = "pm:quality-bands-detail";

/** Every raw FactSet field the quality score uses. One list drives the
 *  calibration pull, the shadow route's live pull and the audit read-out, so
 *  they can never describe different formulas. The FF_ROIC / FF_ROE / FF_ROA
 *  (ANN) and FF_OPER_MGN / FF_GROSS_MGN (LTM) forms are the ones the live
 *  scoring snapshot already requests (app/lib/factset-fundamentals.ts). */
export const QUALITY_SOURCE_FIELDS = [
  { key: "roicAnn0", formula: "FF_ROIC(ANN,0)", label: "Return on invested capital, latest fiscal year", meaning: "FactSet Fundamentals: net income ÷ invested capital for the most recent completed fiscal year.", unit: "%" },
  { key: "roicAnn2", formula: "FF_ROIC(ANN,-2)", label: "Return on invested capital, two fiscal years earlier", meaning: "FactSet Fundamentals. Used for the two-year direction.", unit: "%" },
  { key: "roeAnn0", formula: "FF_ROE(ANN,0)", label: "Return on equity, latest fiscal year", meaning: "FactSet Fundamentals. The returns measure for banks, insurers and capital-markets firms, where invested capital is not a meaningful base.", unit: "%" },
  { key: "roeAnn2", formula: "FF_ROE(ANN,-2)", label: "Return on equity, two fiscal years earlier", meaning: "FactSet Fundamentals. Two-year direction for financials.", unit: "%" },
  { key: "roaAnn0", formula: "FF_ROA(ANN,0)", label: "Return on assets, latest fiscal year", meaning: "FactSet Fundamentals. Banks only.", unit: "%" },
  { key: "operMgnLtm0", formula: "FF_OPER_MGN(LTM,0)", label: "Operating margin, last 12 months", meaning: "FactSet Fundamentals: operating income ÷ sales, trailing twelve months.", unit: "%" },
  { key: "operMgnLtm8", formula: "FF_OPER_MGN(LTM,-8)", label: "Operating margin, 12 months to two years ago", meaning: "FactSet Fundamentals: the same measure eight quarters earlier. Used for the two-year direction.", unit: "%" },
  { key: "grossMgnLtm0", formula: "FF_GROSS_MGN(LTM,0)", label: "Gross margin, last 12 months", meaning: "FactSet Fundamentals. SHOWN for audit only — not ranked: what counts as cost of goods differs too much between companies in one group.", unit: "%" },
] as const;

export type QualityRawKey = (typeof QUALITY_SOURCE_FIELDS)[number]["key"];
export type RawQualityRow = Partial<Record<QualityRawKey, number | null>>;

export type QualityMetricKey = "returns" | "returnsTrend" | "roa" | "operMargin" | "marginTrend";

export const QUALITY_METRIC_LABEL: Record<QualityMetricKey, string> = {
  returns: "Returns on capital (latest fiscal year)",
  returnsTrend: "Returns on capital, change over two fiscal years (points)",
  roa: "Return on assets (latest fiscal year)",
  operMargin: "Operating margin (last 12 months)",
  marginTrend: "Operating margin, change over two years (points)",
};

/** Weights before re-normalising over the measures actually used. Level
 *  carries more than direction: a business that earns 25% on capital and
 *  slipped a point is still a better business than one that went from 2% to 4%. */
export const QUALITY_WEIGHTS: Record<QualityMetricKey, number> = { returns: 0.4, returnsTrend: 0.15, roa: 0.3, operMargin: 0.3, marginTrend: 0.15 };

/** Blended-percentile cut points: below `one` → 0, below `two` → 1, else 2 (if the top-mark tests pass). */
export const QUALITY_CUTS = { one: 30, two: 70 };
/** A 2 also needs returns on capital of at least this (%): the top of a weak
 *  group still has to earn something. Deliberately low — it is a floor under
 *  the top mark, not a threshold the score is built on. */
export const QUALITY_TOP_MARK_FLOOR_PCT = 5;
/** A measure is ranked only against this many peers or more (same as growth). */
export const QUALITY_MIN_COMPONENTS = 2;
/** Values outside these are treated as a data error and dropped, with a reason
 *  (a 4,000% ROE is a near-zero equity base, not a great business). */
export const QUALITY_SANITY = { returns: [-200, 300], roa: [-100, 100], operMargin: [-300, 100] } as const;
const FINANCIAL_GROUPS = ["Banks", "Insurance", "Capital Markets / Diversified Financials"];
const PARKED_GROUPS = ["REITs / Real Estate"];
/** What a healthy calibration looks like, per measure — drives the calibration
 *  self-checks (score-input-validation `runCalibrationChecks`). Levels are in
 *  %, the two "change" measures in percentage points. */
export const QUALITY_EXPECTATIONS: Record<"returns" | "returnsTrend" | "roa" | "operMargin" | "marginTrend", MetricExpectation> = {
  returns: { label: "Returns on capital (%)", medianRange: [3, 35], minSpread: 5, groupMedianRange: [-5, 60], droppedFor: PARKED_GROUPS },
  returnsTrend: { label: "Returns on capital, two-year change (points)", medianRange: [-6, 6], minSpread: 2, groupMedianRange: [-15, 15], droppedFor: PARKED_GROUPS },
  roa: { label: "Return on assets (%)", medianRange: [0.2, 4], minSpread: 0.2, groupMedianRange: [0, 5], onlyFor: ["Banks"] },
  operMargin: { label: "Operating margin (%)", medianRange: [5, 35], minSpread: 8, groupMedianRange: [-10, 60], droppedFor: [...FINANCIAL_GROUPS, ...PARKED_GROUPS] },
  marginTrend: { label: "Operating margin, two-year change (points)", medianRange: [-5, 5], minSpread: 2, groupMedianRange: [-15, 15], droppedFor: [...FINANCIAL_GROUPS, ...PARKED_GROUPS] },
};

/** Per-playbook handling. `returnsFrom` picks the returns measure; `drop`
 *  removes measures that do not mean what they say for that business model;
 *  `park` = no meaningful measure is in the feed, so the group is not ranked. */
export const QUALITY_GROUP_RULES: Record<string, { returnsFrom?: "roe"; useRoa?: boolean; drop?: QualityMetricKey[]; park?: string; note: string }> = {
  Banks: { returnsFrom: "roe", useRoa: true, drop: ["operMargin", "marginTrend"], note: "A bank is leveraged by design: ranked on return on equity and return on assets. Operating margin is not meaningful and is not used." },
  Insurance: { returnsFrom: "roe", drop: ["operMargin", "marginTrend"], note: "Ranked on return on equity. The combined ratio would be the right margin measure but is not in the FactSet feed; operating margin is not used." },
  "Capital Markets / Diversified Financials": { returnsFrom: "roe", drop: ["operMargin", "marginTrend"], note: "Ranked on return on equity. Operating margin is dropped because brokers report net revenue and asset managers gross, so it does not compare inside the group." },
  "REITs / Real Estate": { park: "Return on equity and margins are distorted by depreciation and FFO is not in the FactSet feed — not ranked.", note: "Not ranked: no meaningful returns measure for a REIT is in the feed." },
};

export type QualityInputs = Partial<Record<QualityMetricKey, number>>;
export type QualityExclusion = { metric: QualityMetricKey; reason: string };

const num = (v: unknown): v is number => typeof v === "number" && isFinite(v);
// One shared range check (score-input-validation) — the same one growth uses.
const within = (v: number, range: readonly [number, number]) => checkValue("value", v, range).ok;

/** Raw FactSet fields → the quality measures, with a reason for each one that could not be formed. */
export function deriveQualityInputs(raw: RawQualityRow, group: string | null): { inputs: QualityInputs; excluded: QualityExclusion[]; parked: string | null; returnsBasis: "ROIC" | "ROE" } {
  const rule = group ? QUALITY_GROUP_RULES[group] : undefined;
  const inputs: QualityInputs = {};
  const excluded: QualityExclusion[] = [];
  const skip = (metric: QualityMetricKey, reason: string) => excluded.push({ metric, reason });
  const returnsBasis = rule?.returnsFrom === "roe" ? "ROE" : "ROIC";
  if (rule?.park) return { inputs, excluded, parked: rule.park, returnsBasis };
  const dropped = new Set(rule?.drop ?? []);

  const now = returnsBasis === "ROE" ? raw.roeAnn0 : raw.roicAnn0;
  const then = returnsBasis === "ROE" ? raw.roeAnn2 : raw.roicAnn2;
  if (!num(now)) skip("returns", `no ${returnsBasis} for the latest fiscal year`);
  else if (!within(now, QUALITY_SANITY.returns)) skip("returns", `${returnsBasis} of ${now.toFixed(0)}% is outside the believable range (a near-zero capital base) — treated as a data problem, not ranked`);
  else inputs.returns = now;

  if (inputs.returns == null) skip("returnsTrend", "no returns level to measure a change from");
  else if (!num(then)) skip("returnsTrend", `no ${returnsBasis} two fiscal years earlier`);
  else if (!within(then, QUALITY_SANITY.returns)) skip("returnsTrend", `${returnsBasis} two years earlier (${then.toFixed(0)}%) is outside the believable range`);
  else inputs.returnsTrend = inputs.returns - then;

  if (rule?.useRoa) {
    if (!num(raw.roaAnn0)) skip("roa", "no return on assets for the latest fiscal year");
    else if (!within(raw.roaAnn0, QUALITY_SANITY.roa)) skip("roa", "return on assets is outside the believable range");
    else inputs.roa = raw.roaAnn0;
  }

  if (dropped.has("operMargin")) skip("operMargin", "not meaningful for this business model");
  else if (!num(raw.operMgnLtm0)) skip("operMargin", "no trailing operating margin");
  else if (!within(raw.operMgnLtm0, QUALITY_SANITY.operMargin)) skip("operMargin", `operating margin of ${raw.operMgnLtm0.toFixed(0)}% is outside the believable range`);
  else inputs.operMargin = raw.operMgnLtm0;

  if (dropped.has("marginTrend")) skip("marginTrend", "not meaningful for this business model");
  else if (inputs.operMargin == null) skip("marginTrend", "no operating margin to measure a change from");
  else if (!num(raw.operMgnLtm8)) skip("marginTrend", "no operating margin two years earlier");
  else if (!within(raw.operMgnLtm8, QUALITY_SANITY.operMargin)) skip("marginTrend", "operating margin two years earlier is outside the believable range");
  else inputs.marginTrend = inputs.operMargin - raw.operMgnLtm8;

  return { inputs, excluded, parked: null, returnsBasis };
}

/** One peer group's distributions: each measure's values, sorted ascending, winsorised (growth-score `winsorSort`). */
export type QualityGroup = { group: string; n: number; metrics: Partial<Record<QualityMetricKey, number[]>> };
export type QualityBands = {
  calibratedAt: string;
  universeSize: number;
  listVersion: string;
  groups: Record<string, QualityGroup>;
  sectors: Record<string, QualityGroup>;
  /** Result of the calibration self-checks (absent on bands stored before they existed). */
  selfChecks?: SelfChecks;
};

export type QualityDetailRow = {
  ticker: string; sector: string | null; industry: string | null; group: string;
  /** "CA" for a TSX 60 constituent, "US" for an S&P 500 one. */
  country: "CA" | "US";
  /** FG_MKT_VALUE at calibration, in millions (reporting currency as FactSet returns it). */
  marketCap: number | null;
  raw: RawQualityRow;
  values: QualityInputs;
  excluded: { metric: string; reason: string }[];
  parked: string | null;
};
export type QualityDetail = { calibratedAt: string; rows: QualityDetailRow[]; droppedNoSector: string[] };

export type QualityComponent = { metric: QualityMetricKey; label: string; value: number; percentile: number; weight: number; groupMedian: number | null };

export type QualityWorking = {
  rankedIn: string;
  groupSize: number;
  foldedFrom: string | null;
  groupNote: string | null;
  returnsBasis: "ROIC" | "ROE";
  components: QualityComponent[];
  excluded: QualityExclusion[];
  /** Set when the whole group is not ranked (REITs). */
  parked: string | null;
  blendedPercentile: number | null;
  topMark: { inTopBand: boolean; returnsAtOrAboveMedian: boolean; clearsFloor: boolean } | null;
  /** 0–2. null → DATA GAP (parked group, or fewer than two rankable measures). */
  computedScore: number | null;
  /** Why the score is null, in words. */
  gapReason: string | null;
  calibratedAt: string;
  /** Health of the bands this was ranked against. */
  bands?: { ageDays: number | null; warning: string | null; selfChecked: boolean | null };
};

/**
 * The computed quality score for one company.
 *
 * A 2 needs: blended percentile ≥ QUALITY_CUTS.two AND returns on capital at
 * or above the group median (direction alone cannot earn the top mark) AND
 * returns ≥ QUALITY_TOP_MARK_FLOOR_PCT. Negative returns on capital → 0.
 */
export function computeQualityScore(args: { raw: RawQualityRow; playbookGroup: string | null; sector: string | null; bands: QualityBands; now?: Date }): QualityWorking {
  const { raw, playbookGroup, sector, bands } = args;
  const health = bandsHealth(bands, args.now);
  const pg = playbookGroup ? bands.groups[playbookGroup] : undefined;
  const sg = sector ? bands.sectors[sector] : undefined;
  // A group with its OWN measure rules (financials) must never fold into a
  // sector ranked on different measures: an ROE ranked against a sector's
  // ROICs would be meaningless. Such a group parks instead when too small.
  const hasOwnRule = !!(playbookGroup && QUALITY_GROUP_RULES[playbookGroup]);
  const usePlaybook = !!pg && pg.n >= MIN_GROUP_SIZE;
  const dist = usePlaybook ? pg : hasOwnRule ? undefined : sg ?? pg;
  const { inputs, excluded, parked, returnsBasis } = deriveQualityInputs(raw, playbookGroup);

  const base: QualityWorking = {
    rankedIn: dist?.group ?? "unranked",
    groupSize: dist?.n ?? 0,
    foldedFrom: !usePlaybook && !hasOwnRule && pg && sg ? pg.group : null,
    groupNote: playbookGroup ? QUALITY_GROUP_RULES[playbookGroup]?.note ?? null : null,
    returnsBasis, components: [], excluded, parked,
    blendedPercentile: null, topMark: null, computedScore: null, gapReason: null,
    calibratedAt: bands.calibratedAt,
    bands: { ageDays: health.ageDays, warning: health.warning, selfChecked: health.selfChecked },
  };
  // Runtime guard: bands that are too old, undated, or failed their own checks are not used.
  if (!health.usable) return { ...base, gapReason: health.reason };
  if (parked) return { ...base, gapReason: parked };
  if (!dist) return { ...base, gapReason: hasOwnRule ? `the ${playbookGroup} peer group has fewer than ${MIN_GROUP_SIZE} names and cannot be folded into a sector ranked on different measures` : "no peer group on file for this company" };

  const components: QualityComponent[] = [];
  for (const metric of Object.keys(QUALITY_WEIGHTS) as QualityMetricKey[]) {
    const value = inputs[metric];
    if (value == null) continue;
    const sorted = dist.metrics[metric];
    if (!sorted || sorted.length < MIN_GROUP_SIZE) { excluded.push({ metric, reason: "peer group too thin to rank this measure" }); continue; }
    components.push({ metric, label: QUALITY_METRIC_LABEL[metric], value, percentile: percentileOf(sorted, value), weight: QUALITY_WEIGHTS[metric], groupMedian: quantile(sorted, 50) });
  }
  const wSum = components.reduce((s, c) => s + c.weight, 0);
  for (const c of components) c.weight = wSum > 0 ? c.weight / wSum : 0;
  base.components = components;

  const level = components.find((c) => c.metric === "returns");
  // The LEVEL of returns is the category's subject; without it the direction
  // measures alone would rank an improving loss-maker as a quality business.
  if (!level) return { ...base, gapReason: `no rankable ${returnsBasis} — the level of returns is required` };
  if (components.length < QUALITY_MIN_COMPONENTS) return { ...base, gapReason: "fewer than two rankable measures" };

  const blended = components.reduce((s, c) => s + c.percentile * c.weight, 0);
  const inTopBand = blended >= QUALITY_CUTS.two;
  const returnsAtOrAboveMedian = level.percentile >= 50;
  const clearsFloor = level.value >= QUALITY_TOP_MARK_FLOOR_PCT;
  let score: number;
  if (level.value < 0) score = 0;
  else if (blended < QUALITY_CUTS.one) score = 0;
  else if (inTopBand && returnsAtOrAboveMedian && clearsFloor) score = 2;
  else score = 1;

  return { ...base, blendedPercentile: Math.round(blended * 10) / 10, topMark: { inTopBand, returnsAtOrAboveMedian, clearsFloor }, computedScore: score };
}

export const QUALITY_METRICS = Object.keys(QUALITY_WEIGHTS) as QualityMetricKey[];

/**
 * Build the peer-group distributions from the per-company rows. Pure, so the
 * calibration route and the tests share it.
 *
 * SECTOR groups (the fold-in target for a small playbook group) are built
 * ONLY from companies ranked on the standard measures (ROIC + operating
 * margin). A bank's ROE never enters a sector distribution, so a small
 * group folded into "Financials" is still compared ROIC with ROIC.
 */
export function buildQualityBands(rows: Pick<QualityDetailRow, "group" | "sector" | "values" | "parked">[], meta: { calibratedAt: string; listVersion: string; selfChecks?: SelfChecks }): QualityBands {
  type R = (typeof rows)[number];
  const byGroup = new Map<string, R[]>();
  const bySector = new Map<string, R[]>();
  for (const r of rows) {
    if (r.parked) continue;
    byGroup.set(r.group, [...(byGroup.get(r.group) ?? []), r]);
    if (r.sector && !QUALITY_GROUP_RULES[r.group]) bySector.set(r.sector, [...(bySector.get(r.sector) ?? []), r]);
  }
  const build = (name: string, rs: R[]): QualityGroup => {
    const metrics: QualityGroup["metrics"] = {};
    for (const m of QUALITY_METRICS) {
      const vals = rs.map((r) => r.values[m]).filter((v): v is number => typeof v === "number" && isFinite(v));
      if (vals.length) metrics[m] = winsorSort(vals);
    }
    return { group: name, n: rs.length, metrics };
  };
  return {
    calibratedAt: meta.calibratedAt,
    universeSize: rows.length,
    listVersion: meta.listVersion,
    groups: Object.fromEntries([...byGroup].map(([g, rs]) => [g, build(g, rs)])),
    sectors: Object.fromEntries([...bySector].map(([g, rs]) => [g, build(g, rs)])),
    ...(meta.selfChecks ? { selfChecks: meta.selfChecks } : {}),
  };
}
