/**
 * Shared input validation + calibration self-checks for the COMPUTED scores
 * (growth — live; quality — shadow). Pure: no I/O, no imports from the score
 * libraries (they import this), so the rules live in one place.
 *
 * Three jobs:
 *   1. `checkValue` — every derived metric passes a typed check (finite, inside
 *      a believable range for that metric) before it may be ranked. A failed
 *      check is a DATA GAP for that metric with a reason a person can read;
 *      it is never ranked and never becomes a zero.
 *   2. `runCalibrationChecks` — distribution sanity on every calibration run
 *      (dry run and confirm). A HARD failure means the bands must not be
 *      stored; a WARNING is shown but does not block.
 *   3. `bandsHealth` — the runtime guard: are the stored bands usable today?
 *
 * What this CANNOT do: prove a FactSet formula returns what its name says.
 * That needs a person comparing a sample with a FactSet terminal — see the
 * spot-check set and the verification log (pm:scoring-verification).
 */

export type Range = readonly [number, number];
export type ValueCheck = { ok: true; value: number } | { ok: false; reason: string };

export const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A derived metric is usable only when it is a finite number inside `range`. */
export function checkValue(what: string, v: unknown, range: Range, unit = "%"): ValueCheck {
  if (!isFiniteNumber(v)) return { ok: false, reason: `${what} is not a number` };
  if (v < range[0] || v > range[1]) return { ok: false, reason: `${what} of ${v.toFixed(0)}${unit} is outside the believable range (${range[0]} to ${range[1]}${unit}) — treated as a data problem, not ranked` };
  return { ok: true, value: v };
}

// ── Calibration self-checks ───────────────────────────────────────────────

export type CheckLevel = "hard" | "warn" | "info";
export type CalibrationCheck = { id: string; level: CheckLevel; ok: boolean; detail: string };
export type SelfChecks = { ranAt: string; passed: boolean; hardFailures: string[]; warnings: string[] };

export type CheckRow = {
  ticker: string;
  group: string;
  /** Derived metric values, in the metric's unit (growth: %, quality: % or points). */
  values: Partial<Record<string, number>>;
  excluded: { metric: string; reason: string }[];
  country?: "CA" | "US";
  marketCap?: number | null;
};

export type MetricExpectation = {
  /** Shown in messages. */
  label: string;
  /** The universe MEDIAN must sit inside this, else the column is in the wrong unit or the wrong field (hard). */
  medianRange: Range;
  /** The spread between the 10th and 90th percentile must be at least this (a
   *  percent column that is really a ratio has a spread well under 1) (hard). */
  minSpread: number;
  /** A group median outside this is flagged for a look (warning). */
  groupMedianRange: Range;
  /** Groups for which the metric is dropped by design (not counted as missing). */
  droppedFor?: string[];
};

const q = (sorted: number[], p: number): number | null => {
  if (!sorted.length) return null;
  const idx = (sorted.length - 1) * (p / 100), lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
};
const r1 = (n: number | null) => (n == null ? null : Math.round(n * 10) / 10);
/** Exclusion reasons with their figures blanked, so they can be counted. */
const reasonKey = (reason: string) => reason.replace(/-?\d+(\.\d+)?%?/g, "N");

export type CalibrationReport = {
  checks: CalibrationCheck[];
  selfChecks: SelfChecks;
  /** Per metric: universe coverage and distribution. */
  metrics: Record<string, { withValue: number; expected: number; coveragePct: number; p10: number | null; median: number | null; p90: number | null; exclusions: Record<string, number> }>;
  /** Per group: size, market mix and each metric's distribution. */
  groups: { group: string; names: number; us: number; canada: number; medianMarketCapM: number | null; metrics: Record<string, { n: number; p10: number | null; median: number | null; p90: number | null }> }[];
};

/** Fewer priced companies than this is a partial pull. */
export const MIN_UNIVERSE = 300;
/** A metric present for under this share (%) of the companies it applies to is a HARD failure. */
export const MIN_COVERAGE_HARD = 40;
/** …and under this share is a warning. */
export const MIN_COVERAGE_WARN = 70;

/**
 * Sanity checks on one calibration pull. HARD failures (bands must not be stored):
 *   - too few companies, or a failed batch (a partial pull)
 *   - the same ticker twice
 *   - a metric present for under MIN_COVERAGE_HARD of the companies it applies to
 *   - a metric whose universe median or spread says it is in the wrong unit
 * Warnings: thin coverage, an unusual group median, many unmatched constituents.
 */
export function runCalibrationChecks(args: {
  rows: CheckRow[];
  expectations: Record<string, MetricExpectation>;
  requested: number;
  failedChunks: number;
  unmatched: string[];
  now?: Date;
}): CalibrationReport {
  const { rows, expectations, requested, failedChunks, unmatched } = args;
  const checks: CalibrationCheck[] = [];
  const add = (id: string, level: CheckLevel, ok: boolean, detail: string) => checks.push({ id, level, ok, detail });

  add("universe-size", "hard", rows.length >= MIN_UNIVERSE, `${rows.length} of ${requested} companies returned data (at least ${MIN_UNIVERSE} needed)`);
  add("no-failed-batches", "hard", failedChunks === 0, failedChunks === 0 ? "every batch of the FactSet pull succeeded" : `${failedChunks} batch(es) of the FactSet pull failed — this is a partial pull`);

  const seen = new Map<string, number>();
  for (const r of rows) seen.set(r.ticker.toUpperCase(), (seen.get(r.ticker.toUpperCase()) ?? 0) + 1);
  const dupes = [...seen].filter(([, n]) => n > 1).map(([t]) => t);
  add("no-duplicates", "hard", dupes.length === 0, dupes.length ? `listed more than once: ${dupes.slice(0, 12).join(", ")}` : "no company appears twice");
  const manyUnmatched = unmatched.length > Math.max(15, requested * 0.05);
  add("unmatched-constituents", manyUnmatched ? "warn" : "info", !manyUnmatched, unmatched.length ? `${unmatched.length} constituent(s) FactSet returned no sector for (dropped): ${unmatched.slice(0, 20).join(", ")}` : "every constituent was matched");

  const metrics: CalibrationReport["metrics"] = {};
  for (const [m, exp] of Object.entries(expectations)) {
    const applies = rows.filter((r) => !(exp.droppedFor ?? []).includes(r.group));
    const vals = applies.map((r) => r.values[m]).filter(isFiniteNumber).sort((a, b) => a - b);
    const exclusions: Record<string, number> = {};
    for (const r of applies) for (const e of r.excluded) if (e.metric === m) exclusions[reasonKey(e.reason)] = (exclusions[reasonKey(e.reason)] ?? 0) + 1;
    const coverage = applies.length ? (vals.length / applies.length) * 100 : 0;
    const p10 = q(vals, 10), med = q(vals, 50), p90 = q(vals, 90);
    metrics[m] = { withValue: vals.length, expected: applies.length, coveragePct: Math.round(coverage), p10: r1(p10), median: r1(med), p90: r1(p90), exclusions };
    add(`coverage:${m}`, coverage < MIN_COVERAGE_HARD ? "hard" : "warn", coverage >= MIN_COVERAGE_WARN, `${exp.label}: ${vals.length} of ${applies.length} companies have a value (${Math.round(coverage)}%)`);
    if (med != null && p10 != null && p90 != null) {
      const unitOk = med >= exp.medianRange[0] && med <= exp.medianRange[1] && p90 - p10 >= exp.minSpread;
      add(`units:${m}`, "hard", unitOk, unitOk
        ? `${exp.label}: universe median ${med.toFixed(1)}, 10th–90th percentile ${p10.toFixed(1)} to ${p90.toFixed(1)} — consistent with the expected unit`
        : `${exp.label}: universe median ${med.toFixed(2)} and 10th–90th percentile ${p10.toFixed(2)} to ${p90.toFixed(2)} do not look like the expected unit (median should sit between ${exp.medianRange[0]} and ${exp.medianRange[1]}, spread at least ${exp.minSpread}). A ratio where a percent is expected, or the wrong field.`);
    } else add(`units:${m}`, "hard", false, `${exp.label}: no values at all`);
  }

  const groupNames = [...new Set(rows.map((r) => r.group))];
  const groups: CalibrationReport["groups"] = groupNames.map((g) => {
    const rs = rows.filter((r) => r.group === g);
    const caps = rs.map((r) => r.marketCap).filter(isFiniteNumber).sort((a, b) => a - b);
    const gm: Record<string, { n: number; p10: number | null; median: number | null; p90: number | null }> = {};
    for (const [m, exp] of Object.entries(expectations)) {
      const vals = rs.map((r) => r.values[m]).filter(isFiniteNumber).sort((a, b) => a - b);
      if (!vals.length) continue;
      const med = q(vals, 50)!;
      gm[m] = { n: vals.length, p10: r1(q(vals, 10)), median: r1(med), p90: r1(q(vals, 90)) };
      if (vals.length >= 5 && (med < exp.groupMedianRange[0] || med > exp.groupMedianRange[1])) add(`group-median:${g}:${m}`, "warn", false, `${g} — ${exp.label}: group median of ${med.toFixed(1)} is unusual (expected ${exp.groupMedianRange[0]} to ${exp.groupMedianRange[1]}). Check a few names in this group.`);
    }
    return { group: g, names: rs.length, us: rs.filter((r) => r.country === "US").length, canada: rs.filter((r) => r.country === "CA").length, medianMarketCapM: r1(q(caps, 50)), metrics: gm };
  }).sort((a, b) => b.names - a.names);

  const hardFailures = checks.filter((c) => c.level === "hard" && !c.ok).map((c) => c.detail);
  const warnings = checks.filter((c) => c.level === "warn" && !c.ok).map((c) => c.detail);
  return { checks, selfChecks: { ranAt: (args.now ?? new Date()).toISOString(), passed: hardFailures.length === 0, hardFailures, warnings }, metrics, groups };
}

// ── Runtime guard ─────────────────────────────────────────────────────────

/** Bands older than this get a visible warning beside every score that uses them. */
export const BANDS_WARN_DAYS = 300;
/** Bands older than this are NOT used: the category parks as a data gap until re-calibrated. */
export const BANDS_MAX_DAYS = 450;

export type BandsHealth = {
  usable: boolean;
  ageDays: number | null;
  /** Why the bands cannot be used (usable = false). */
  reason: string | null;
  /** Shown beside the score when usable but something needs attention. */
  warning: string | null;
  /** true = the stored bands passed their self-checks; false = they failed; null = calibrated before self-checks existed. */
  selfChecked: boolean | null;
};

export function bandsHealth(bands: { calibratedAt?: string; selfChecks?: SelfChecks } | null | undefined, now: Date = new Date()): BandsHealth {
  if (!bands) return { usable: false, ageDays: null, reason: "the peer-group bands have not been calibrated", warning: null, selfChecked: null };
  const t = Date.parse(bands.calibratedAt ?? "");
  if (!Number.isFinite(t)) return { usable: false, ageDays: null, reason: "the peer-group bands carry no calibration date", warning: null, selfChecked: null };
  const ageDays = Math.floor((now.getTime() - t) / 86_400_000);
  const selfChecked = bands.selfChecks ? bands.selfChecks.passed : null;
  if (selfChecked === false) return { usable: false, ageDays, reason: `the peer-group bands failed their own checks when calibrated (${bands.selfChecks!.hardFailures[0] ?? "see the calibration report"})`, warning: null, selfChecked };
  if (ageDays > BANDS_MAX_DAYS) return { usable: false, ageDays, reason: `the peer-group bands are ${ageDays} days old (limit ${BANDS_MAX_DAYS}) — re-run the calibration`, warning: null, selfChecked };
  const notes: string[] = [];
  if (ageDays > BANDS_WARN_DAYS) notes.push(`the peer-group bands are ${ageDays} days old — re-calibrate soon`);
  if (selfChecked === null) notes.push("these bands were calibrated before the automatic checks existed — re-run the calibration to check them");
  return { usable: true, ageDays, reason: null, warning: notes.length ? notes.join("; ") : null, selfChecked };
}
