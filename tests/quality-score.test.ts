import { describe, expect, it } from "vitest";
import { percentileOf, winsorSort } from "@/app/lib/growth-score";
import { buildQualityBands, computeQualityScore, deriveQualityInputs, MIN_GROUP_SIZE, QUALITY_TOP_MARK_FLOOR_PCT, type QualityBands, type RawQualityRow } from "@/app/lib/quality-score";

// "now", not a fixed date: bands older than 450 days are refused by the runtime guard, and a fixed date would start failing the deploy gate in 2028.
const META = { calibratedAt: new Date().toISOString(), listVersion: "test" };

/** `n` companies in one group; company i has ROIC 2i, flat trend, margin 3i, flat trend. */
function peers(group: string, sector: string, n: number) {
  return Array.from({ length: n }, (_, i) => {
    const raw: RawQualityRow = { roicAnn0: 2 * (i + 1), roicAnn2: 2 * (i + 1), operMgnLtm0: 3 * (i + 1), operMgnLtm8: 3 * (i + 1), roeAnn0: 5 + i, roeAnn2: 5 + i, roaAnn0: 0.5 + i / 10 };
    const { inputs, parked } = deriveQualityInputs(raw, group);
    return { group, sector, values: inputs, parked, raw };
  });
}
const bandsOf = (...sets: ReturnType<typeof peers>[]): QualityBands => buildQualityBands(sets.flat(), META);

describe("percentile + winsorising (shared with growth)", () => {
  it("mid-rank percentile", () => {
    expect(percentileOf([1, 2, 3, 4], 0)).toBe(0);
    expect(percentileOf([1, 2, 3, 4], 5)).toBe(100);
    expect(percentileOf([1, 2, 3, 4], 2)).toBe(37.5); // 1 below + half of the tie
    expect(percentileOf([], 2)).toBe(50);
  });
  it("winsorises the tails of a group of ten or more, leaves a small group alone", () => {
    const w = winsorSort([1, 2, 3, 4, 5, 6, 7, 8, 9, 1000]);
    expect(w[w.length - 1]).toBeLessThan(1000);
    expect(w[w.length - 1]).toBeGreaterThan(9);
    expect(winsorSort([3, 1, 1000])).toEqual([1, 3, 1000]);
  });
});

describe("deriveQualityInputs — sector-specific measures", () => {
  it("standard company: ROIC level + direction, operating margin level + direction", () => {
    const r = deriveQualityInputs({ roicAnn0: 18, roicAnn2: 12, operMgnLtm0: 30, operMgnLtm8: 25, roeAnn0: 99 }, "Software / IT Services");
    expect(r.returnsBasis).toBe("ROIC");
    expect(r.inputs).toEqual({ returns: 18, returnsTrend: 6, operMargin: 30, marginTrend: 5 });
    expect(r.parked).toBeNull();
  });
  it("bank: ROE and ROA, never an operating margin", () => {
    const r = deriveQualityInputs({ roicAnn0: 3, roeAnn0: 14, roeAnn2: 12, roaAnn0: 1.1, operMgnLtm0: 40, operMgnLtm8: 38 }, "Banks");
    expect(r.returnsBasis).toBe("ROE");
    expect(r.inputs).toEqual({ returns: 14, returnsTrend: 2, roa: 1.1 });
    expect(r.excluded.find((e) => e.metric === "operMargin")?.reason).toMatch(/not meaningful/);
  });
  it("insurer and capital-markets firm: ROE only, margins dropped", () => {
    for (const g of ["Insurance", "Capital Markets / Diversified Financials"]) {
      const r = deriveQualityInputs({ roeAnn0: 11, roeAnn2: 13, operMgnLtm0: 20, operMgnLtm8: 20, roaAnn0: 2 }, g);
      expect(r.inputs).toEqual({ returns: 11, returnsTrend: -2 });
    }
  });
  it("REIT: parked, nothing derived", () => {
    const r = deriveQualityInputs({ roicAnn0: 4, roeAnn0: 6, operMgnLtm0: 50 }, "REITs / Real Estate");
    expect(r.parked).toMatch(/FFO/);
    expect(r.inputs).toEqual({});
  });
  it("missing or unbelievable inputs are dropped with a reason — never a zero", () => {
    const r = deriveQualityInputs({ roicAnn0: 4000, operMgnLtm0: null }, "Industrials");
    expect(r.inputs).toEqual({});
    expect(r.excluded.find((e) => e.metric === "returns")?.reason).toMatch(/believable range/);
    expect(r.excluded.find((e) => e.metric === "operMargin")?.reason).toMatch(/no trailing operating margin/);
    expect(r.excluded.find((e) => e.metric === "returnsTrend")).toBeTruthy();
  });
});

describe("buildQualityBands", () => {
  it("keeps financial groups' ROE out of the sector distributions and leaves parked REITs out entirely", () => {
    const b = bandsOf(peers("Banks", "Financials", 10), peers("Payments", "Financials", 3), peers("REITs / Real Estate", "Real Estate", 9));
    expect(b.groups["Banks"].n).toBe(10);
    expect(b.groups["REITs / Real Estate"]).toBeUndefined();
    expect(b.sectors["Real Estate"]).toBeUndefined();
    expect(b.sectors["Financials"].n).toBe(3); // Payments only
    expect(b.sectors["Financials"].metrics.returns).toEqual([2, 4, 6]); // ROIC, not the banks' ROE
  });
});

describe("computeQualityScore", () => {
  const bands = bandsOf(peers("Industrials", "Industrials", 20));
  const score = (raw: RawQualityRow, group = "Industrials", sector = "Industrials", b = bands) => computeQualityScore({ raw, playbookGroup: group, sector, bands: b });

  it("top of the group on level → 2; the working carries every number", () => {
    const w = score({ roicAnn0: 39, roicAnn2: 39, operMgnLtm0: 58, operMgnLtm8: 58 });
    expect(w.computedScore).toBe(2);
    expect(w.rankedIn).toBe("Industrials");
    expect(w.groupSize).toBe(20);
    expect(w.components.map((c) => c.metric)).toEqual(["returns", "returnsTrend", "operMargin", "marginTrend"]);
    expect(w.components.reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 9);
    expect(w.topMark).toEqual({ inTopBand: true, returnsAtOrAboveMedian: true, clearsFloor: true });
  });
  it("middle of the group → 1; bottom → 0", () => {
    expect(score({ roicAnn0: 20, roicAnn2: 20, operMgnLtm0: 30, operMgnLtm8: 30 }).computedScore).toBe(1);
    expect(score({ roicAnn0: 2, roicAnn2: 4, operMgnLtm0: 3, operMgnLtm8: 6 }).computedScore).toBe(0);
  });
  it("negative returns on capital → 0 even with a fat margin", () => {
    expect(score({ roicAnn0: -5, roicAnn2: -30, operMgnLtm0: 60, operMgnLtm8: 10 }).computedScore).toBe(0);
  });
  it("direction alone cannot earn the top mark: below-median returns stay at 1", () => {
    const w = score({ roicAnn0: 18, roicAnn2: -150, operMgnLtm0: 60, operMgnLtm8: -200 });
    expect(w.blendedPercentile!).toBeGreaterThanOrEqual(70);
    expect(w.topMark!.returnsAtOrAboveMedian).toBe(false);
    expect(w.computedScore).toBe(1);
  });
  it("the top of a weak group still has to clear the returns floor", () => {
    const weak = buildQualityBands(Array.from({ length: 10 }, (_, i) => ({ group: "Weak", sector: "X", parked: null, values: { returns: (i + 1) * 0.3, operMargin: i + 1 } })), META);
    const w = computeQualityScore({ raw: { roicAnn0: 3, operMgnLtm0: 10 }, playbookGroup: "Weak", sector: "X", bands: weak });
    expect(w.topMark!.inTopBand).toBe(true);
    expect(3).toBeLessThan(QUALITY_TOP_MARK_FLOOR_PCT);
    expect(w.computedScore).toBe(1);
  });

  it("DATA GAP paths: no returns level, one measure only, a parked group, no bands for the group", () => {
    const noLevel = score({ operMgnLtm0: 30, operMgnLtm8: 25 });
    expect(noLevel.computedScore).toBeNull();
    expect(noLevel.gapReason).toMatch(/level of returns is required/);
    const one = score({ roicAnn0: 20 });
    expect(one.computedScore).toBeNull();
    expect(one.gapReason).toMatch(/fewer than two/);
    const reit = score({ roicAnn0: 5, operMgnLtm0: 50 }, "REITs / Real Estate", "Real Estate");
    expect(reit.computedScore).toBeNull();
    expect(reit.parked).toBeTruthy();
    const unknown = score({ roicAnn0: 20, operMgnLtm0: 30 }, "Nowhere", "Nowhere");
    expect(unknown.computedScore).toBeNull();
    expect(unknown.gapReason).toMatch(/no peer group/);
  });

  it("a small playbook group folds into its GICS sector", () => {
    const b = bandsOf(peers("Telecom", "Communication Services", MIN_GROUP_SIZE - 1), peers("Media / Entertainment / Interactive", "Communication Services", 12));
    const w = computeQualityScore({ raw: { roicAnn0: 30, roicAnn2: 30, operMgnLtm0: 40, operMgnLtm8: 40 }, playbookGroup: "Telecom", sector: "Communication Services", bands: b });
    expect(w.rankedIn).toBe("Communication Services");
    expect(w.foldedFrom).toBe("Telecom");
    expect(w.groupSize).toBe(MIN_GROUP_SIZE - 1 + 12);
    expect(w.computedScore).not.toBeNull();
  });
  it("a small FINANCIAL group does not fold into a sector ranked on different measures — it parks", () => {
    const b = bandsOf(peers("Insurance", "Financials", MIN_GROUP_SIZE - 1), peers("Payments", "Financials", 12));
    const w = computeQualityScore({ raw: { roeAnn0: 15, roeAnn2: 12 }, playbookGroup: "Insurance", sector: "Financials", bands: b });
    expect(w.computedScore).toBeNull();
    expect(w.gapReason).toMatch(/cannot be folded/);
  });
  it("a bank is ranked on ROE + ROA inside the bank group", () => {
    const b = bandsOf(peers("Banks", "Financials", 15));
    const w = computeQualityScore({ raw: { roeAnn0: 19, roeAnn2: 19, roaAnn0: 1.9, operMgnLtm0: 99 }, playbookGroup: "Banks", sector: "Financials", bands: b });
    expect(w.returnsBasis).toBe("ROE");
    expect(w.components.map((c) => c.metric)).toEqual(["returns", "returnsTrend", "roa"]);
    expect(w.computedScore).toBe(2);
  });
});
