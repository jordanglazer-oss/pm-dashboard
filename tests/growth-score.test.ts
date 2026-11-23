import { describe, expect, it } from "vitest";
import {
  buildGrowthBands, computeGrowthScore, deriveGrowthInputs, percentileOf, quantile, resolveGrowthScore, winsorSort,
  GROWTH_PLAUSIBLE, MIN_GROUP_SIZE, type GrowthBandRow, type GrowthBands, type RawGrowthRow,
} from "@/app/lib/growth-score";
import { fy1RevisionPct, FIXED_FY_CANDIDATES, MIN_REVISION_BASE } from "@/app/lib/factset-fundamentals";
import { bandsHealth, runCalibrationChecks, BANDS_MAX_DAYS, BANDS_WARN_DAYS, type CheckRow } from "@/app/lib/score-input-validation";
import { GROWTH_EXPECTATIONS } from "@/app/lib/growth-score";

/** The growth score is LIVE. Before Nov 2026 it had no tests at all. */

const NOW = new Date("2026-11-22T12:00:00Z");
const CALIBRATED = "2026-09-20T00:00:00.000Z";

// A healthy company: sales 100 → 110 (+10%), EPS 2.00 → 2.30 (+15%), LTG 12%, sales 3y 70 → 100 (+12.6%/yr).
const healthy: RawGrowthRow = { salesNtm: 110, salesLtmA: 100, salesLtm: 100, epsNtm: 2.3, epsLtmA: 2.0, ltg: 12, salesAnn0: 100, salesAnn3: 70, bpsAnn0: 20, bpsAnn3: 15 };

/** 20 companies in one group, each metric spread evenly from `lo` to `hi`. */
function spread(group: string, sector: string, n: number, lo: number, hi: number, extra: Partial<GrowthBandRow> = {}): GrowthBandRow[] {
  return Array.from({ length: n }, (_, i) => {
    const v = lo + ((hi - lo) * i) / (n - 1);
    return { group, sector, values: { fwdSales: v, fwdEps: v, ltg: v, delivered: v }, country: "US" as const, marketCap: 50_000 + i * 10_000, ...extra };
  });
}
const bandsOf = (rows: GrowthBandRow[], calibratedAt = CALIBRATED): GrowthBands => buildGrowthBands(rows, { calibratedAt, listVersion: "test", selfChecks: { ranAt: calibratedAt, passed: true, hardFailures: [], warnings: [] } });
const software = spread("Software", "Technology", 21, 0, 20);
const bands = bandsOf(software);
const score = (raw: RawGrowthRow, over: Partial<Parameters<typeof computeGrowthScore>[0]> = {}) =>
  computeGrowthScore({ raw, playbookGroup: "Software", sector: "Technology", bands, revisionPct: null, now: NOW, ...over });

describe("growth inputs — deriving the four metrics", () => {
  it("forms all four from clean inputs, with the arithmetic a person can check", () => {
    const { inputs, excluded, salesBasis } = deriveGrowthInputs(healthy, "Software");
    expect(inputs.fwdSales).toBeCloseTo(10, 6);
    expect(inputs.fwdEps).toBeCloseTo(15, 6);
    expect(inputs.ltg).toBe(12);
    expect(inputs.delivered).toBeCloseTo((Math.pow(100 / 70, 1 / 3) - 1) * 100, 6);
    expect(excluded).toEqual([]);
    expect(salesBasis).toBe("estimates");
  });

  it("a negative or tiny EPS base is a data gap for that metric, never a huge growth rate", () => {
    // −0.10 → +0.40 is not "+500%".
    const neg = deriveGrowthInputs({ ...healthy, epsLtmA: -0.1, epsNtm: 0.4 }, "Software");
    expect(neg.inputs.fwdEps).toBeUndefined();
    expect(neg.excluded.find((e) => e.metric === "fwdEps")!.reason).toMatch(/negative or too small/);
    // 0.12 → 1.20 clears the absolute floor but is still a near-zero base (+900%).
    const tiny = deriveGrowthInputs({ ...healthy, epsLtmA: 0.12, epsNtm: 1.2 }, "Software");
    expect(tiny.inputs.fwdEps).toBeUndefined();
    expect(tiny.excluded.find((e) => e.metric === "fwdEps")!.reason).toMatch(/believable range.*too small a base/);
  });

  it("zero, negative, missing, NaN and string inputs never produce a number", () => {
    for (const bad of [0, -5, null, undefined, NaN, Infinity, "110" as unknown as number]) {
      const r = deriveGrowthInputs({ ...healthy, salesNtm: bad as number }, "Software");
      expect(r.inputs.fwdSales, String(bad)).toBeUndefined();
      expect(r.excluded.some((e) => e.metric === "fwdSales")).toBe(true);
    }
    const zeroBase = deriveGrowthInputs({ ...healthy, salesLtmA: 0, salesLtm: 0 }, "Software");
    expect(zeroBase.inputs.fwdSales).toBeUndefined();
    const noHistory = deriveGrowthInputs({ ...healthy, salesAnn3: 0 }, "Software");
    expect(noHistory.inputs.delivered).toBeUndefined();
    const negHistory = deriveGrowthInputs({ ...healthy, salesAnn3: -10 }, "Software");
    expect(negHistory.inputs.delivered).toBeUndefined();
  });

  it("values outside the believable range are dropped with a reason", () => {
    const merger = deriveGrowthInputs({ ...healthy, salesNtm: 900 }, "Software"); // +800%
    expect(merger.inputs.fwdSales).toBeUndefined();
    expect(merger.excluded.find((e) => e.metric === "fwdSales")!.reason).toMatch(/outside the believable range/);
    expect(merger.salesBasis).toBeNull();
    const ratioLtg = deriveGrowthInputs({ ...healthy, ltg: 250 }, "Software");
    expect(ratioLtg.inputs.ltg).toBeUndefined();
    const wildCagr = deriveGrowthInputs({ ...healthy, salesAnn0: 1000, salesAnn3: 1 }, "Software"); // 900%/yr
    expect(wildCagr.inputs.delivered).toBeUndefined();
    // A real collapse still counts: −60% forward sales with falling EPS stays in.
    const collapse = deriveGrowthInputs({ ...healthy, salesNtm: 40, epsNtm: 0.5 }, "Software");
    expect(collapse.inputs.fwdSales).toBeCloseTo(-60, 6);
    expect(GROWTH_PLAUSIBLE.fwdSales[0]).toBeLessThan(-60);
  });

  it("falls back to as-reported trailing sales only when the estimates figure is missing, and says so", () => {
    const r = deriveGrowthInputs({ ...healthy, salesLtmA: null, salesLtm: 105 }, "Software");
    expect(r.inputs.fwdSales).toBeCloseTo((5 / 105) * 100, 6);
    expect(r.salesBasis).toBe("as-reported");
  });

  it("the reporting-basis break still drops forward sales (collapsing sales, growing EPS)", () => {
    const r = deriveGrowthInputs({ ...healthy, salesNtm: 54 }, "Software"); // −46% with EPS +15%
    expect(r.inputs.fwdSales).toBeUndefined();
    expect(r.excluded.find((e) => e.metric === "fwdSales")!.reason).toMatch(/different bases/);
  });

  it("banks drop forward sales and measure delivered growth on book value; REITs drop the EPS metrics", () => {
    const bank = deriveGrowthInputs(healthy, "Banks");
    expect(bank.inputs.fwdSales).toBeUndefined();
    expect(bank.inputs.delivered).toBeCloseTo((Math.pow(20 / 15, 1 / 3) - 1) * 100, 6);
    const reit = deriveGrowthInputs(healthy, "REITs / Real Estate");
    expect(reit.inputs.fwdEps).toBeUndefined();
    expect(reit.inputs.ltg).toBeUndefined();
    expect(reit.inputs.fwdSales).toBeCloseTo(10, 6);
  });
});

describe("percentile maths", () => {
  it("mid-rank percentile: ties share the middle, the ends are bounded, an empty group is neutral", () => {
    expect(percentileOf([1, 2, 3, 4, 5], 3)).toBe(50);
    expect(percentileOf([1, 2, 2, 2, 5], 2)).toBe(50); // (1 below + 3 equal / 2) / 5
    expect(percentileOf([1, 2, 3], 0)).toBe(0);
    expect(percentileOf([1, 2, 3], 99)).toBe(100);
    expect(percentileOf([], 3)).toBe(50);
  });

  it("quantile interpolates and winsorising only clamps the tails of a group of 10+", () => {
    expect(quantile([0, 10], 50)).toBe(5);
    expect(quantile([], 50)).toBeNull();
    expect(winsorSort([3, 1, 2])).toEqual([1, 2, 3]);
    const w = winsorSort([...Array.from({ length: 49 }, (_, i) => i), 10_000]);
    expect(w[w.length - 1]).toBeLessThan(10_000);
    expect(w[25]).toBe(25);
  });

  it("ranking is monotonic: a higher value never ranks lower", () => {
    const sorted = winsorSort(software.map((r) => r.values.fwdSales!));
    let last = -1;
    for (let v = -5; v <= 30; v += 0.5) { const p = percentileOf(sorted, v); expect(p).toBeGreaterThanOrEqual(last); last = p; }
  });
});

describe("bands — who is ranked against whom", () => {
  it("a sector distribution leaves out the delivered growth of banks and insurers (book value, not sales)", () => {
    const rows = [
      ...spread("Banks", "Financials", 10, 100, 109),          // book-value growth, deliberately far from the rest
      ...spread("Payments", "Financials", 4, 1, 4),
      ...spread("Exchanges", "Financials", 8, 5, 12),
    ];
    const b = bandsOf(rows);
    const sectorDelivered = b.sectors.Financials.metrics.delivered!;
    expect(Math.max(...sectorDelivered)).toBeLessThan(50); // no bank value leaked in
    expect(sectorDelivered).toHaveLength(12);
    // The other metrics still include every company in the sector.
    expect(b.sectors.Financials.metrics.fwdEps).toHaveLength(22);
    // A bank is still ranked on book value inside its OWN group.
    expect(b.groups.Banks.metrics.delivered).toHaveLength(10);
  });

  it(`a group under ${MIN_GROUP_SIZE} names folds into its sector; the working says so`, () => {
    const rows = [...spread("Payments", "Financials", 4, 1, 4), ...spread("Exchanges", "Financials", 8, 5, 12)];
    const w = computeGrowthScore({ raw: healthy, playbookGroup: "Payments", sector: "Financials", bands: bandsOf(rows), revisionPct: null, now: NOW });
    expect(w.rankedIn).toBe("Financials");
    expect(w.foldedFrom).toBe("Payments");
    expect(w.groupSize).toBe(12);
  });

  it("an unknown group and sector cannot be ranked → data gap with a reason, not a score", () => {
    const w = computeGrowthScore({ raw: healthy, playbookGroup: "Nowhere", sector: "Nothing", bands, revisionPct: null, now: NOW });
    expect(w.computedScore).toBeNull();
    expect(w.gapReason).toMatch(/fewer than two/);
  });

  it("records the group's make-up and flags a company smaller than 90% of its peers", () => {
    expect(bands.groups.Software.makeUp).toMatchObject({ us: 21, canada: 0 });
    const small = score(healthy, { marketCapM: 2_000 });
    expect(small.size?.smallerThanPeers).toBe(true);
    expect(small.size?.note).toMatch(/smaller than 90%/);
    const large = score(healthy, { marketCapM: 150_000 });
    expect(large.size?.smallerThanPeers).toBe(false);
    expect(large.peerUniverse).toMatch(/S&P 500/);
  });
});

describe("the score — golden cases (any change to the maths shows up here)", () => {
  it("normal company", () => {
    const w = score(healthy);
    expect(w.components.map((c) => [c.metric, Math.round(c.percentile), Math.round(c.weight * 100)])).toEqual([["fwdSales", 50, 30], ["fwdEps", 71, 30], ["ltg", 60, 20], ["delivered", 62, 20]]);
    expect(w.blendedPercentile).toBe(60.7); // 0.3×50 + 0.3×71.43 + 0.2×59.52 + 0.2×61.90
    expect(w.baseScore).toBe(2);
    expect(w.computedScore).toBe(2);
    expect(w.topMark).toEqual({ inTopBand: false, noMetricBelowMedian: true, clearsFloor: true, primaryForwardGrowth: expect.closeTo(10, 6) });
    expect(w.negativeForwardRule).toBe(false);
    expect(w.salesBasis).toBe("estimates");
    expect(w.bands).toEqual({ ageDays: 63, warning: null, selfChecked: true });
  });

  it("outstanding growth earns the 3 only when it is broad-based and clears the floor", () => {
    const star: RawGrowthRow = { salesNtm: 125, salesLtmA: 100, epsNtm: 2.6, epsLtmA: 2.0, ltg: 25, salesAnn0: 100, salesAnn3: 50 };
    expect(score(star).computedScore).toBe(3);
    // Same blend but one metric below the group median → stays a 2.
    const lopsided = score({ ...star, ltg: 2 });
    expect(lopsided.topMark?.noMetricBelowMedian).toBe(false);
    expect(lopsided.computedScore).toBe(2);
  });

  it("negative forward growth scores 0 and the working names the rule", () => {
    const w = score({ ...healthy, salesNtm: 97, epsNtm: 1.9 });
    expect(w.baseScore).toBe(0);
    expect(w.negativeForwardRule).toBe(true);
  });

  it("a missing metric re-weights over what is left (weights still sum to 100%)", () => {
    const w = score({ ...healthy, ltg: null });
    expect(w.components.map((c) => c.metric)).toEqual(["fwdSales", "fwdEps", "delivered"]);
    expect(w.components.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 9);
    expect(w.components.map((c) => Math.round(c.weight * 1000) / 10)).toEqual([37.5, 37.5, 25]);
    expect(w.excluded.map((e) => e.metric)).toEqual(["ltg"]);
  });

  it("fewer than two usable metrics is a data gap with a reason — never a score", () => {
    const w = score({ salesNtm: 110, salesLtmA: 100 });
    expect(w.computedScore).toBeNull();
    expect(w.baseScore).toBeNull();
    expect(w.gapReason).toMatch(/fewer than two/);
  });

  it("financial: a bank is ranked on EPS, LTG and book-value growth only", () => {
    const b = bandsOf(spread("Banks", "Financials", 12, 0, 22));
    const w = computeGrowthScore({ raw: healthy, playbookGroup: "Banks", sector: "Financials", bands: b, revisionPct: null, now: NOW });
    expect(w.components.map((c) => c.metric)).toEqual(["fwdEps", "ltg", "delivered"]);
    expect(w.topMark?.primaryForwardGrowth).toBeCloseTo(15, 6); // EPS is the primary forward metric when sales is dropped
    expect(w.computedScore).not.toBeNull();
  });

  it("Canadian name in a mixed group is ranked exactly like a US one (no country split)", () => {
    const mixed = bandsOf([...spread("Software", "Technology", 18, 0, 17), ...spread("Software", "Technology", 3, 18, 20, { country: "CA" })]);
    expect(mixed.groups.Software.makeUp).toMatchObject({ us: 18, canada: 3 });
    const w = computeGrowthScore({ raw: healthy, playbookGroup: "Software", sector: "Technology", bands: mixed, revisionPct: null, now: NOW });
    expect(w.rankedIn).toBe("Software");
    expect(w.groupSize).toBe(21);
  });
});

describe("the revision adjustment", () => {
  it("is symmetric at ±3% and never lifts an average grower to the top mark", () => {
    expect(score(healthy, { revisionPct: 3.1 }).revision.adjustment).toBe(1);
    expect(score(healthy, { revisionPct: -3.1 }).revision.adjustment).toBe(-1);
    expect(score(healthy, { revisionPct: 3 }).revision.adjustment).toBe(0);
    expect(score(healthy, { revisionPct: -3 }).revision.adjustment).toBe(0);
    expect(score(healthy, { revisionPct: null }).revision.adjustment).toBe(0);
    expect(score(healthy, { revisionPct: -10 }).computedScore).toBe(1);
    // base 2, all metrics at/above median, floor cleared → an upward revision may make it 3 …
    expect(score(healthy, { revisionPct: 10 }).computedScore).toBe(3);
    // … but not when a metric sits below the group median.
    expect(score({ ...healthy, ltg: 2, salesNtm: 118, epsNtm: 2.4 }, { revisionPct: 10 }).computedScore).toBe(2);
  });

  it("is measured on the SAME fiscal year, including last calendar year (January–March, before Q4 is reported)", () => {
    const lastYear = new Date().getUTCFullYear() - 1;
    expect(FIXED_FY_CANDIDATES).toContain(lastYear);
    const v = { epsEstFy1: 5, [`epsFy${lastYear}Now`]: 5, [`epsFy${lastYear}Ago3m`]: 4 };
    expect(fy1RevisionPct(v)).toBeCloseTo(25, 6);
    // No candidate year matches the rolling FY+1 → not measurable (never a guess across a year roll).
    expect(fy1RevisionPct({ epsEstFy1: 5, [`epsFy${lastYear}Now`]: 6, [`epsFy${lastYear}Ago3m`]: 4 })).toBeNull();
  });

  it("a tiny consensus is too small a base to take a % of", () => {
    const y = new Date().getUTCFullYear();
    expect(MIN_REVISION_BASE).toBe(0.1);
    expect(fy1RevisionPct({ epsEstFy1: 0.03, [`epsFy${y}Now`]: 0.03, [`epsFy${y}Ago3m`]: 0.02 })).toBeNull(); // one cent, not "+50%"
    expect(fy1RevisionPct({ epsEstFy1: 0.5, [`epsFy${y}Now`]: 0.5, [`epsFy${y}Ago3m`]: 0 })).toBeNull();
    expect(fy1RevisionPct({ epsEstFy1: 0.5, [`epsFy${y}Now`]: 0.5, [`epsFy${y}Ago3m`]: null })).toBeNull();
    // A loss narrowing is an UPWARD revision: −1.00 → −0.50 = +50%.
    expect(fy1RevisionPct({ epsEstFy1: -0.5, [`epsFy${y}Now`]: -0.5, [`epsFy${y}Ago3m`]: -1 })).toBeCloseTo(50, 6);
  });
});

describe("runtime guard — bands that should not be trusted are not used", () => {
  it("missing, undated, failed or too-old bands are unusable; old-ish or unchecked bands warn", () => {
    expect(bandsHealth(null, NOW)).toMatchObject({ usable: false });
    expect(bandsHealth({ calibratedAt: "not a date" }, NOW)).toMatchObject({ usable: false });
    expect(bandsHealth({ calibratedAt: CALIBRATED, selfChecks: { ranAt: CALIBRATED, passed: false, hardFailures: ["units wrong"], warnings: [] } }, NOW)).toMatchObject({ usable: false, selfChecked: false });
    const tooOld = new Date(NOW.getTime() - (BANDS_MAX_DAYS + 1) * 86_400_000).toISOString();
    expect(bandsHealth({ calibratedAt: tooOld }, NOW).usable).toBe(false);
    const ageing = new Date(NOW.getTime() - (BANDS_WARN_DAYS + 1) * 86_400_000).toISOString();
    expect(bandsHealth({ calibratedAt: ageing, selfChecks: { ranAt: ageing, passed: true, hardFailures: [], warnings: [] } }, NOW)).toMatchObject({ usable: true, warning: expect.stringMatching(/days old/) });
    // Bands calibrated before the checks existed stay usable (the live book must not go dark) but say so.
    expect(bandsHealth({ calibratedAt: CALIBRATED }, NOW)).toMatchObject({ usable: true, selfChecked: null, warning: expect.stringMatching(/before the automatic checks/) });
  });

  it("the score parks with the reason when the bands are unusable", () => {
    const stale: GrowthBands = { ...bands, calibratedAt: new Date(NOW.getTime() - 500 * 86_400_000).toISOString() };
    const w = computeGrowthScore({ raw: healthy, playbookGroup: "Software", sector: "Technology", bands: stale, revisionPct: 10, now: NOW });
    expect(w.computedScore).toBeNull();
    expect(w.components).toEqual([]);
    expect(w.gapReason).toMatch(/500 days old/);
  });
});

describe("resolveGrowthScore — the model cannot override the computed score", () => {
  it("parks growth when there is a reason to, whatever the model returned", () => {
    expect(resolveGrowthScore({ computedScore: null, parkReason: "bands missing", modelRaw: 3, modelReturned: true })).toEqual({ kind: "parked", reason: "bands missing", placeholder: 1 });
  });
  it("holds the model to one point either side of the computed score", () => {
    expect(resolveGrowthScore({ computedScore: 1, parkReason: null, modelRaw: 3, modelReturned: true })).toEqual({ kind: "computed", score: 2, adjustment: 1, modelUsed: true, clampedFrom: 3 });
    expect(resolveGrowthScore({ computedScore: 3, parkReason: null, modelRaw: 0, modelReturned: true })).toMatchObject({ score: 2, adjustment: -1, clampedFrom: 0 });
    expect(resolveGrowthScore({ computedScore: 2, parkReason: null, modelRaw: 2, modelReturned: true })).toMatchObject({ score: 2, adjustment: 0, clampedFrom: null });
    expect(resolveGrowthScore({ computedScore: 3, parkReason: null, modelRaw: 9, modelReturned: true })).toMatchObject({ score: 3, adjustment: 0 });
    expect(resolveGrowthScore({ computedScore: 2, parkReason: null, modelRaw: 2.6, modelReturned: true })).toMatchObject({ score: 3, adjustment: 1 });
  });
  it("a missing or non-numeric model value is 'no adjustment', not a zero", () => {
    for (const bad of [undefined, null, "3", NaN]) expect(resolveGrowthScore({ computedScore: 3, parkReason: null, modelRaw: bad, modelReturned: true })).toEqual({ kind: "computed", score: 3, adjustment: 0, modelUsed: false, clampedFrom: null });
    expect(resolveGrowthScore({ computedScore: 2, parkReason: null, modelRaw: 0, modelReturned: false })).toMatchObject({ score: 2, modelUsed: false });
  });
  it("with nothing computed and no reason to park, the model's read stands (and is labelled by the route)", () => {
    expect(resolveGrowthScore({ computedScore: null, parkReason: null, modelRaw: 2, modelReturned: true })).toEqual({ kind: "model" });
  });
});

describe("calibration self-checks", () => {
  const rowsOf = (n: number, f: (i: number) => Partial<CheckRow["values"]>): CheckRow[] =>
    Array.from({ length: n }, (_, i) => ({ ticker: `T${i}`, group: i % 2 ? "Software" : "Banks", values: f(i), excluded: [], country: i % 10 === 0 ? "CA" : "US", marketCap: 1000 + i }));
  const good = rowsOf(400, (i) => ({ fwdSales: (i % 40) - 5, fwdEps: (i % 60) - 10, ltg: 4 + (i % 25), delivered: (i % 30) - 4 }));
  const run = (rows: CheckRow[], over: Partial<Parameters<typeof runCalibrationChecks>[0]> = {}) => runCalibrationChecks({ rows, expectations: GROWTH_EXPECTATIONS, requested: rows.length, failedChunks: 0, unmatched: [], now: NOW, ...over });

  it("passes a healthy pull and reports each metric and group", () => {
    const r = run(good);
    expect(r.selfChecks.passed).toBe(true);
    expect(r.metrics.ltg).toMatchObject({ withValue: 400, expected: 400, coveragePct: 100 });
    expect(r.groups).toHaveLength(2);
    expect(r.groups[0]).toMatchObject({ names: 200 });
    expect(r.groups.reduce((s, g) => s + g.canada, 0)).toBe(40);
  });

  it("HARD: a partial pull, a failed batch or a duplicate", () => {
    expect(run(good.slice(0, 250)).selfChecks.hardFailures.join(" ")).toMatch(/at least 300 needed/);
    expect(run(good, { failedChunks: 1 }).selfChecks.passed).toBe(false);
    expect(run([...good, good[0]]).selfChecks.hardFailures.join(" ")).toMatch(/more than once: T0/);
  });

  it("HARD: a percent column that is really a ratio (the classic silent error)", () => {
    const ratio = good.map((r) => ({ ...r, values: { ...r.values, ltg: (r.values.ltg as number) / 100 } }));
    const r = run(ratio);
    expect(r.selfChecks.passed).toBe(false);
    expect(r.selfChecks.hardFailures.join(" ")).toMatch(/Long-term growth estimate.*do not look like the expected unit/);
  });

  it("HARD: a metric missing for most of the universe; WARN: thin coverage and an odd group median", () => {
    const sparse = good.map((r, i) => (i % 4 ? { ...r, values: { ...r.values, delivered: undefined } } : r));
    expect(run(sparse).selfChecks.hardFailures.join(" ")).toMatch(/Delivered 3-year growth.*25%/);
    const thin = good.map((r, i) => (i % 3 === 0 ? { ...r, values: { ...r.values, delivered: undefined } } : r));
    const t = run(thin);
    expect(t.selfChecks.passed).toBe(true);
    expect(t.selfChecks.warnings.join(" ")).toMatch(/Delivered 3-year growth/);
    const odd = good.map((r) => (r.group === "Banks" ? { ...r, values: { ...r.values, fwdEps: 90 } } : r));
    expect(run(odd).selfChecks.warnings.join(" ")).toMatch(/Banks — Forward EPS growth.*unusual/);
  });

  it("a metric dropped by design for a group is not counted as missing", () => {
    const banksNoSales = good.map((r) => (r.group === "Banks" ? { ...r, values: { ...r.values, fwdSales: undefined } } : r));
    const r = run(banksNoSales);
    expect(r.metrics.fwdSales).toMatchObject({ expected: 200, withValue: 200, coveragePct: 100 });
    expect(r.selfChecks.passed).toBe(true);
  });
});
